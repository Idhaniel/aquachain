#!/usr/bin/env bash
# Copies cryptogen-generated user credentials into caliper/identities/ with
# predictable file names (cryptogen private key files have random-ish names).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ORG_DIR="$ROOT_DIR/network/organizations/peerOrganizations"
OUT_DIR="$ROOT_DIR/caliper/identities"
mkdir -p "$OUT_DIR"

copy_user() {
    local domain=$1 user=$2 alias=$3
    local msp="$ORG_DIR/$domain/users/$user@$domain/msp"
    cp "$msp"/signcerts/*.pem "$OUT_DIR/$alias.cert.pem"
    cp "$msp"/keystore/*     "$OUT_DIR/$alias.key.pem"
    echo "prepared $alias"
}

copy_user fishfarmers.aquachain.com    User1 fishfarmers-user1
copy_user fishfarmers.aquachain.com    User2 fishfarmers-user2
copy_user fishfarmers.aquachain.com    User3 fishfarmers-user3
copy_user energyprovider.aquachain.com User1 energyprovider-user1
copy_user fishprocessors.aquachain.com User1 fishprocessors-user1

echo "All Caliper identities in $OUT_DIR"
