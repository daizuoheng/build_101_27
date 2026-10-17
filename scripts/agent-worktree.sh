#!/usr/bin/env bash
# Crea un worktree aislado para un agente: rama propia, bases propias (dev y test) y puerto propio.
# Uso (desde la raíz del clon, con .env.local completo):
#   scripts/agent-worktree.sh <nombre> <rama-base> <puerto>
#   ej: scripts/agent-worktree.sh plan feat/operacion 3201
# Crea ../radar-<nombre> en la rama feat/<nombre>, bases radar_urbano_<nombre> y radar_urbano_<nombre>_test.
# Borrar: git worktree remove ../radar-<nombre> && dropdb radar_urbano_<nombre> && dropdb radar_urbano_<nombre>_test
set -euo pipefail

name="${1:?nombre (ej: plan)}"
base="${2:?rama base (ej: feat/operacion)}"
port="${3:?puerto (ej: 3201)}"
[[ "$name" =~ ^[a-z0-9_]+$ ]] || { echo "nombre: solo minúsculas, números y _"; exit 1; }

root="$(git rev-parse --show-toplevel)"
dir="$(dirname "$root")/radar-$name"
db="radar_urbano_$name"
[[ -f "$root/.env.local" ]] || { echo "falta $root/.env.local (copiá .env.example y completalo)"; exit 1; }

git -C "$root" fetch -q origin || true
git -C "$root" show-ref --verify -q "refs/heads/$base" || base="origin/$base"
if git -C "$root" show-ref --verify -q "refs/heads/feat/$name"; then
  git -C "$root" worktree add "$dir" "feat/$name"
else
  # --no-track: un `git push` del agente nunca debe ir a la rama base.
  git -C "$root" worktree add --no-track -b "feat/$name" "$dir" "$base"
fi

# Secretos compartidos por symlink (nunca se copian al repo); bases y puerto propios en .env.local.
[[ -f "$root/.env" ]] && ln -sf "$root/.env" "$dir/.env"
grep -vE '^(DATABASE_URL|DATABASE_URL_TEST|PORT|STORAGE_LOCAL_DIR)=' "$root/.env.local" > "$dir/.env.local"
{
  echo "DATABASE_URL=postgres://localhost/$db"
  echo "DATABASE_URL_TEST=postgres://localhost/${db}_test"
  echo "PORT=$port"
  echo "STORAGE_LOCAL_DIR=storage"
} >> "$dir/.env.local"

createdb "$db" 2>/dev/null || echo "base $db ya existía"
createdb "${db}_test" 2>/dev/null || echo "base ${db}_test ya existía"

cd "$dir"
pnpm install --frozen-lockfile --silent
pnpm -s cli migrate
pnpm -s cli seed
pnpm -s cli seed-demo

cat <<EOF

Listo: $dir (rama feat/$name, base $db, puerto $port)
  cd $dir
  pnpm dev --port $port     # web
  pnpm worker               # worker de esta base
  pnpm test                 # usa ${db}_test, no choca con otros agentes
Abrí la sesión del agente en esa carpeta.
EOF
