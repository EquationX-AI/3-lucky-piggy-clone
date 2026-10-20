#!/usr/bin/env bash
# 生成自签证书（SAN 覆盖多域名）
# 用法: gen-cert.sh <输出目录> <域名1> [域名2] ...
set -euo pipefail
OUTDIR="${1:?用法: gen-cert.sh <输出目录> <域名1> ...}"; shift
[ $# -eq 0 ] && { echo "至少需要一个域名"; exit 1; }
mkdir -p "$OUTDIR"
SAN="DNS:$1"; for d in "${@:2}"; do SAN="$SAN,DNS:$d"; done
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$OUTDIR/key.pem" -out "$OUTDIR/cert.pem" \
    -days 365 -subj "/CN=local-slot-replication" \
    -addext "subjectAltName=$SAN" 2>/dev/null
echo "✓ 证书: $OUTDIR/{cert,key}.pem  SAN=$SAN"
