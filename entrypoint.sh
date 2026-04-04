#!/bin/bash
set -e
echo "Starting bot initialization..."
sleep 2
echo "Pushing database schema..."
npx prisma db push --skip-generate || {
  echo "Prisma db push failed"
  exit 1
}
echo "Starting application..."
exec node index.js
