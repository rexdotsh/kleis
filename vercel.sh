#!/bin/bash
echo "env=$VERCEL_ENV"

if [[ $VERCEL_ENV == "production" ]]; then
  echo "migrating..." && bun run db:migrate
fi

bun run build
