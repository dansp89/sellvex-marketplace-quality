#!/usr/bin/env bash
# Ficha da máquina e benchmark de referência, para converter os resultados
# de carga para qualquer servidor que rode exatamente os mesmos comandos.
#
#   bash k6/ficha-maquina.sh [saida.txt] [dir_de_teste_do_disco]
#
# Só precisa de Docker (sysbench e fio rodam em contêiner; nada é instalado
# no host). O teste de disco grava um arquivo de 2 GB em dir_de_teste e o
# apaga no fim. Rodar no servidor alvo com a máquina ociosa.
set -euo pipefail
OUT="${1:-/dev/stdout}"
DIR="${2:-$(mktemp -d)}"
SYSBENCH_IMG="severalnines/sysbench:latest"
FIO_IMG="alpine:3.20"
mkdir -p "$DIR"
{
echo "# ficha da máquina — $(date -Iseconds)"
echo "## cpu"; LC_ALL=C lscpu | grep -E '^(Model name|Architecture|CPU\(s\)|Thread|Core|Socket|CPU max MHz|CPU min MHz|L3)' || true
echo "## memória"; LC_ALL=C free -b | head -2
echo "## disco"; lsblk -d -o NAME,MODEL,SIZE,ROTA,TRAN 2>/dev/null | grep -v loop || true
df -h "$DIR" | tail -1
echo "## sistema"; uname -srm; (grep PRETTY_NAME /etc/os-release || true)
echo "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo ausente)"
echo "## sysbench cpu (1 thread e todas as threads, 30 s)"
docker run --rm "$SYSBENCH_IMG" sysbench cpu --cpu-max-prime=20000 --threads=1 --time=30 run | grep -E 'events per second|95th'
docker run --rm "$SYSBENCH_IMG" sysbench cpu --cpu-max-prime=20000 --threads="$(nproc)" --time=30 run | grep -E 'events per second|95th'
echo "## sysbench memory (1 KiB blocos, 10 GiB, todas as threads)"
docker run --rm "$SYSBENCH_IMG" sysbench memory --memory-block-size=1K --memory-total-size=10G --threads="$(nproc)" run | grep -E 'MiB/sec|transferred'
echo "## fio (arquivo de 2 GB, direct=1, 30 s cada)"
for job in "randread 4k 32" "randwrite 4k 32" "read 1m 8" "write 1m 8"; do
  set -- $job
  docker run --rm -v "$DIR":/t "$FIO_IMG" sh -c "apk add -q fio >/dev/null && fio --name=$1 --filename=/t/fio.dat --size=2G --rw=$1 --bs=$2 --iodepth=$3 \
    --ioengine=libaio --direct=1 --runtime=30 --time_based --group_reporting --output-format=terse --terse-version=3" \
    | awk -F';' -v j="$1-$2-qd$3" '{ if (j ~ /read/) printf "%s: %s IOPS, %.1f MB/s, lat_p99 %s us\n", j, $8, $7/1024, $30; else printf "%s: %s IOPS, %.1f MB/s, lat_p99 %s us\n", j, $49, $48/1024, $71 }'
done
rm -f "$DIR/fio.dat"
} > "$OUT"
