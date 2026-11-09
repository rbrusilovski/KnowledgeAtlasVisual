#!/bin/sh
# Next.js generates route types (PageProps, RouteContext) into the build dir. Only generate them when missing:
# running `next typegen` while `next dev` is up rewrites files the dev server watches and triggers reload loops.
set -e
if [ ! -f .next/types/routes.d.ts ] && [ ! -f .next/dev/types/routes.d.ts ]; then
  next typegen
fi
exec tsc --noEmit
