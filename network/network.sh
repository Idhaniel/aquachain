#!/usr/bin/env bash
#
# AquaChain network orchestration for Hyperledger Fabric v2.5.
#
# Usage:
#   ./network.sh up          # generate crypto, start containers
#   ./network.sh channels    # create energychannel + producechannel (osnadmin) and join peers
#   ./network.sh deploy      # deploy both chaincodes (lifecycle v2)
#   ./network.sh all         # up + channels + deploy
#   ./network.sh down        # stop and wipe everything
#
# Endorsement policy experiment axis (affects Caliper results):
#   CC_POLICY_MODE=AND ./network.sh deploy   (default: both orgs must endorse)
#   CC_POLICY_MODE=OR  ./network.sh deploy   (any one org endorses)
#
# Prerequisites: docker + docker compose, and Fabric v2.5 binaries on PATH
# (peer, orderer, configtxgen, cryptogen, osnadmin) with FABRIC_CFG_PATH
# pointing at a directory containing core.yaml (the fabric-samples/config
# directory from the install script works). See README.md step 1.

set -euo pipefail

NETWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$NETWORK_DIR")"
ORG_DIR="$NETWORK_DIR/organizations"
export FABRIC_CFG_PATH="${FABRIC_CFG_PATH:-$NETWORK_DIR/../fabric-config}"

CC_POLICY_MODE="${CC_POLICY_MODE:-AND}"
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"

ORDERER1_ADMIN=localhost:7053
ORDERER2_ADMIN=localhost:7063
ORDERER3_ADMIN=localhost:7073

ORDERER_CA="$ORG_DIR/ordererOrganizations/aquachain.com/tlsca/tlsca.aquachain.com-cert.pem"
ORDERER1_TLS_DIR="$ORG_DIR/ordererOrganizations/aquachain.com/orderers/orderer1.aquachain.com/tls"
ORDERER2_TLS_DIR="$ORG_DIR/ordererOrganizations/aquachain.com/orderers/orderer2.aquachain.com/tls"
ORDERER3_TLS_DIR="$ORG_DIR/ordererOrganizations/aquachain.com/orderers/orderer3.aquachain.com/tls"

log() { echo -e "\n\033[1;34m### $*\033[0m"; }
die() { echo "ERROR: $*" >&2; exit 1; }

check_prereqs() {
    for bin in cryptogen configtxgen osnadmin peer docker openssl; do
        command -v "$bin" >/dev/null || die "'$bin' not found on PATH (see README step 1)"
    done
    # Guard against stray Fabric installs from other projects shadowing our
    # v2.5 binaries (mixed-version tools cause bizarre, random-looking
    # crypto/TLS failures).
    local pv cv
    pv=$(peer version 2>/dev/null | awk '/Version:/{print $2; exit}')
    case "$pv" in
        v2.5.*|2.5.*) : ;;
        *) die "peer on PATH is '$pv' at $(command -v peer) — need 2.5.x. Fix: export PATH=\$HOME/aquachain/bin:\$PATH (run from any dir), and remove old Fabric binaries found via: which -a peer" ;;
    esac
    cv=$(cryptogen version 2>/dev/null | awk '/Version:/{print $2; exit}')
    case "$cv" in
        v2.5.*|2.5.*) : ;;
        *) die "cryptogen on PATH is '$cv' at $(command -v cryptogen) — need 2.5.x. Old cryptogen produces certs that fail modern verification. Check: which -a cryptogen" ;;
    esac
    echo "Using: peer=$(command -v peer) ($pv), cryptogen=$(command -v cryptogen) ($cv)"
    [ -f "$FABRIC_CFG_PATH/core.yaml" ] || die "FABRIC_CFG_PATH ($FABRIC_CFG_PATH) must contain core.yaml"
}

# Switch the peer CLI to act as a given org admin against a given peer.
as_org() {
    local org=$1
    export CORE_PEER_TLS_ENABLED=true
    case $org in
        fishfarmers0)
            export CORE_PEER_LOCALMSPID=FishFarmersMSP
            export CORE_PEER_ADDRESS=localhost:7051
            export CORE_PEER_TLS_ROOTCERT_FILE=$ORG_DIR/peerOrganizations/fishfarmers.aquachain.com/peers/peer0.fishfarmers.aquachain.com/tls/ca.crt
            export CORE_PEER_MSPCONFIGPATH=$ORG_DIR/peerOrganizations/fishfarmers.aquachain.com/users/Admin@fishfarmers.aquachain.com/msp
            ;;
        fishfarmers1)
            export CORE_PEER_LOCALMSPID=FishFarmersMSP
            export CORE_PEER_ADDRESS=localhost:7151
            export CORE_PEER_TLS_ROOTCERT_FILE=$ORG_DIR/peerOrganizations/fishfarmers.aquachain.com/peers/peer1.fishfarmers.aquachain.com/tls/ca.crt
            export CORE_PEER_MSPCONFIGPATH=$ORG_DIR/peerOrganizations/fishfarmers.aquachain.com/users/Admin@fishfarmers.aquachain.com/msp
            ;;
        energyprovider)
            export CORE_PEER_LOCALMSPID=EnergyProviderMSP
            export CORE_PEER_ADDRESS=localhost:8051
            export CORE_PEER_TLS_ROOTCERT_FILE=$ORG_DIR/peerOrganizations/energyprovider.aquachain.com/peers/peer0.energyprovider.aquachain.com/tls/ca.crt
            export CORE_PEER_MSPCONFIGPATH=$ORG_DIR/peerOrganizations/energyprovider.aquachain.com/users/Admin@energyprovider.aquachain.com/msp
            ;;
        fishprocessors)
            export CORE_PEER_LOCALMSPID=FishProcessorsMSP
            export CORE_PEER_ADDRESS=localhost:9051
            export CORE_PEER_TLS_ROOTCERT_FILE=$ORG_DIR/peerOrganizations/fishprocessors.aquachain.com/peers/peer0.fishprocessors.aquachain.com/tls/ca.crt
            export CORE_PEER_MSPCONFIGPATH=$ORG_DIR/peerOrganizations/fishprocessors.aquachain.com/users/Admin@fishprocessors.aquachain.com/msp
            ;;
        *) die "unknown org $org" ;;
    esac
}

# cryptogen intermittently emits a certificate whose ECDSA signature does
# not verify (random per-cert — one run is fine, the next is not). Go-based
# tools then fail with "x509: ECDSA verification failure" at channel-join /
# TLS time. A broken signature fails the math in every verifier, so we
# sweep EVERY generated cert with openssl right after generation and
# regenerate until the whole tree is clean.
verify_crypto() {
    local bad=0 ca orgdir crt
    # 1) every TLS cert (server + client) against its org's TLS CA
    for ca in "$ORG_DIR"/*Organizations/*/tlsca/tlsca.*-cert.pem; do
        [ -f "$ca" ] || { echo "  missing TLS CA"; return 1; }
        openssl verify -CAfile "$ca" "$ca" >/dev/null 2>&1 \
            || { echo "  bad CA self-signature: ${ca#"$ORG_DIR"/}"; bad=1; }
        orgdir=$(dirname "$(dirname "$ca")")
        while IFS= read -r crt; do
            openssl verify -CAfile "$ca" "$crt" >/dev/null 2>&1 \
                || { echo "  bad TLS cert: ${crt#"$ORG_DIR"/}"; bad=1; }
        done < <(find "$orgdir" -type f \( -name server.crt -o -name client.crt \))
    done
    # 2) every enrollment cert against its org's enrollment CA
    for ca in "$ORG_DIR"/*Organizations/*/ca/ca.*-cert.pem; do
        [ -f "$ca" ] || { echo "  missing enrollment CA"; return 1; }
        openssl verify -CAfile "$ca" "$ca" >/dev/null 2>&1 \
            || { echo "  bad CA self-signature: ${ca#"$ORG_DIR"/}"; bad=1; }
        orgdir=$(dirname "$(dirname "$ca")")
        while IFS= read -r crt; do
            openssl verify -CAfile "$ca" "$crt" >/dev/null 2>&1 \
                || { echo "  bad enrollment cert: ${crt#"$ORG_DIR"/}"; bad=1; }
        done < <(find "$orgdir" -type f -path '*/signcerts/*' -name '*.pem')
    done
    return $bad
}

net_up() {
    check_prereqs
    if [ -d "$ORG_DIR/peerOrganizations" ]; then
        log "Crypto material already exists — skipping cryptogen"
    else
        local attempt=1
        while true; do
            log "Generating crypto material (cryptogen), attempt $attempt"
            rm -rf "$ORG_DIR/peerOrganizations" "$ORG_DIR/ordererOrganizations"
            cryptogen generate \
                --config="$ORG_DIR/cryptogen/crypto-config.yaml" \
                --output="$ORG_DIR"
            if verify_crypto; then
                log "Crypto material verified OK"
                break
            fi
            log "Generated certs failed verification (known cryptogen high-S quirk) — retrying"
            attempt=$((attempt + 1))
            [ "$attempt" -gt 5 ] && die "cryptogen kept producing bad signatures after 5 attempts — check openssl/cryptogen versions"
        done
    fi

    log "Starting containers"
    docker compose -f "$NETWORK_DIR/compose/docker-compose.yaml" up -d
    docker ps --format 'table {{.Names}}\t{{.Status}}' | grep aquachain || true
    log "Waiting 5s for nodes to come up"
    sleep 5
    verify_served_certs
}

# On WSL2 + Docker Desktop, a container can briefly see STALE bind-mount
# content at startup: the process then loads a previous generation's TLS
# cert even though the file on disk (and even inside the container) is
# correct by the time you look. Symptom: "x509: ECDSA verification
# failure" from osnadmin/peer despite openssl-clean material. Defense:
# compare what each node actually SERVES against what is on DISK, and
# restart any container that mismatches so it re-reads the (now correct)
# files.
verify_served_certs() {
    # port : container : cert path on disk
    local checks=(
        "7053:orderer1.aquachain.com:$ORG_DIR/ordererOrganizations/aquachain.com/orderers/orderer1.aquachain.com/tls/server.crt"
        "7063:orderer2.aquachain.com:$ORG_DIR/ordererOrganizations/aquachain.com/orderers/orderer2.aquachain.com/tls/server.crt"
        "7073:orderer3.aquachain.com:$ORG_DIR/ordererOrganizations/aquachain.com/orderers/orderer3.aquachain.com/tls/server.crt"
        "7051:peer0.fishfarmers.aquachain.com:$ORG_DIR/peerOrganizations/fishfarmers.aquachain.com/peers/peer0.fishfarmers.aquachain.com/tls/server.crt"
        "7151:peer1.fishfarmers.aquachain.com:$ORG_DIR/peerOrganizations/fishfarmers.aquachain.com/peers/peer1.fishfarmers.aquachain.com/tls/server.crt"
        "8051:peer0.energyprovider.aquachain.com:$ORG_DIR/peerOrganizations/energyprovider.aquachain.com/peers/peer0.energyprovider.aquachain.com/tls/server.crt"
        "9051:peer0.fishprocessors.aquachain.com:$ORG_DIR/peerOrganizations/fishprocessors.aquachain.com/peers/peer0.fishprocessors.aquachain.com/tls/server.crt"
    )
    local round stale entry port name certfile disk served
    for round in 1 2; do
        stale=()
        log "Checking served TLS certs match disk (round $round)"
        for entry in "${checks[@]}"; do
            port=${entry%%:*}
            name=${entry#*:}; name=${name%%:*}
            certfile=${entry#*:*:}
            # NOTE: s_client exits nonzero on the admin ports (they demand a
            # client cert we don't present) even though it does retrieve the
            # server's certificate — '|| true' keeps set -e from killing us.
            disk=$(openssl x509 -noout -fingerprint -sha256 -in "$certfile" 2>/dev/null || true)
            served=$( (echo | openssl s_client -connect "localhost:$port" 2>/dev/null \
                | openssl x509 -noout -fingerprint -sha256 2>/dev/null) || true)
            if [ -z "$served" ]; then
                echo "  $name (:$port): not answering TLS yet"
                stale+=("$name")
            elif [ "$disk" != "$served" ]; then
                echo "  $name (:$port): SERVING A STALE CERT"
                stale+=("$name")
            fi
        done
        if [ ${#stale[@]} -eq 0 ]; then
            log "All nodes serve current certificates"
            return 0
        fi
        if [ "$round" -eq 1 ]; then
            log "Restarting stale containers: ${stale[*]}"
            docker restart "${stale[@]}" >/dev/null
            sleep 6
        fi
    done
    die "Nodes still serving stale certs after restart. Run: ./network.sh down, then 'wsl --shutdown' in Windows PowerShell, restart Docker Desktop, and try again."
}

create_channel() {
    local profile=$1 channel=$2
    local block="$NETWORK_DIR/channel-artifacts/${channel}.block"
    mkdir -p "$NETWORK_DIR/channel-artifacts"

    log "Generating genesis block for $channel"
    configtxgen -profile "$profile" \
        -outputBlock "$block" \
        -channelID "$channel" \
        -configPath "$NETWORK_DIR/configtx"

    log "Joining all 3 orderers to $channel (osnadmin)"
    for o in 1 2 3; do
        local admin_var="ORDERER${o}_ADMIN" tls_var="ORDERER${o}_TLS_DIR"
        osnadmin channel join \
            --channelID "$channel" \
            --config-block "$block" \
            -o "${!admin_var}" \
            --ca-file "$ORDERER_CA" \
            --client-cert "${!tls_var}/server.crt" \
            --client-key "${!tls_var}/server.key"
    done
}

join_peers() {
    local channel=$1; shift
    local block="$NETWORK_DIR/channel-artifacts/${channel}.block"
    for org in "$@"; do
        as_org "$org"
        log "Joining $org peer to $channel"
        peer channel join -b "$block"
    done
}

channels() {
    check_prereqs
    create_channel EnergyChannel energychannel
    sleep 2
    join_peers energychannel fishfarmers0 fishfarmers1 energyprovider

    create_channel ProduceChannel producechannel
    sleep 2
    join_peers producechannel fishfarmers0 fishfarmers1 fishprocessors

    log "Channels ready. energychannel: FishFarmers+EnergyProvider | producechannel: FishFarmers+FishProcessors"
}

# deploy_cc <name> <path> <channel> <endorsing-org-a> <endorsing-org-b> <msp-a> <msp-b>
deploy_cc() {
    local name=$1 path=$2 channel=$3 orgA=$4 orgB=$5 mspA=$6 mspB=$7
    local pkg="$NETWORK_DIR/channel-artifacts/${name}.tar.gz"
    local policy

    if [ "$CC_POLICY_MODE" = "OR" ]; then
        policy="OR('${mspA}.peer','${mspB}.peer')"
    else
        policy="AND('${mspA}.peer','${mspB}.peer')"
    fi
    log "Deploying $name to $channel with endorsement policy: $policy"

    log "Packaging $name"
    peer lifecycle chaincode package "$pkg" \
        --path "$path" --lang node --label "${name}_${CC_VERSION}"

    # Install on all peers of both endorsing orgs (FishFarmers has 2 peers)
    local install_targets=("$orgA" "$orgB")
    [ "$orgA" = "fishfarmers0" ] && install_targets=(fishfarmers0 fishfarmers1 "$orgB")

    for org in "${install_targets[@]}"; do
        as_org "$org"
        log "Installing $name on $org"
        peer lifecycle chaincode install "$pkg"
    done

    as_org "$orgA"
    local package_id
    package_id=$(peer lifecycle chaincode calculatepackageid "$pkg")
    log "Package ID: $package_id"

    for org in "$orgA" "$orgB"; do
        as_org "$org"
        log "Approving $name for ${CORE_PEER_LOCALMSPID}"
        peer lifecycle chaincode approveformyorg \
            -o localhost:7050 --ordererTLSHostnameOverride orderer1.aquachain.com \
            --tls --cafile "$ORDERER_CA" \
            --channelID "$channel" --name "$name" \
            --version "$CC_VERSION" --package-id "$package_id" \
            --sequence "$CC_SEQUENCE" \
            --signature-policy "$policy"
    done

    as_org "$orgA"
    log "Checking commit readiness"
    peer lifecycle chaincode checkcommitreadiness \
        --channelID "$channel" --name "$name" \
        --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
        --signature-policy "$policy" --output json

    # commit requires endorsement from both orgs' peers
    local peerAddrA peerCaA peerAddrB peerCaB
    as_org "$orgA"; peerAddrA=$CORE_PEER_ADDRESS; peerCaA=$CORE_PEER_TLS_ROOTCERT_FILE
    as_org "$orgB"; peerAddrB=$CORE_PEER_ADDRESS; peerCaB=$CORE_PEER_TLS_ROOTCERT_FILE

    as_org "$orgA"
    log "Committing $name on $channel"
    peer lifecycle chaincode commit \
        -o localhost:7050 --ordererTLSHostnameOverride orderer1.aquachain.com \
        --tls --cafile "$ORDERER_CA" \
        --channelID "$channel" --name "$name" \
        --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
        --signature-policy "$policy" \
        --peerAddresses "$peerAddrA" --tlsRootCertFiles "$peerCaA" \
        --peerAddresses "$peerAddrB" --tlsRootCertFiles "$peerCaB"

    log "$name committed. Querying:"
    peer lifecycle chaincode querycommitted --channelID "$channel" --name "$name"
}

deploy() {
    check_prereqs
    deploy_cc energy-trading "$ROOT_DIR/chaincode/energy-trading" energychannel \
        fishfarmers0 energyprovider FishFarmersMSP EnergyProviderMSP
    deploy_cc produce-trading "$ROOT_DIR/chaincode/produce-trading" producechannel \
        fishfarmers0 fishprocessors FishFarmersMSP FishProcessorsMSP
    log "Both chaincodes deployed."
}

net_down() {
    log "Tearing down network"
    docker compose -f "$NETWORK_DIR/compose/docker-compose.yaml" down --volumes --remove-orphans || true
    # remove chaincode containers/images spawned by the peers
    docker ps -aq --filter "name=dev-peer" | xargs -r docker rm -f
    docker images -q 'dev-peer*' | xargs -r docker rmi -f
    rm -rf "$ORG_DIR/peerOrganizations" "$ORG_DIR/ordererOrganizations" \
           "$NETWORK_DIR/channel-artifacts"
    log "Done."
}

case "${1:-}" in
    up)       net_up ;;
    channels) channels ;;
    deploy)   deploy ;;
    all)      net_up; channels; deploy ;;
    down)     net_down ;;
    *)
        echo "Usage: $0 {up|channels|deploy|all|down}"
        exit 1
        ;;
esac
