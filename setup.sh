#!/bin/bash
### pwndbg needed to setup 

if [ -z "$1" ]
  then 
    echo "Pwndbg is needed in order for vHeap to work. To install it: https://github.com/pwndbg/pwndbg"
    echo "If you already have pwndbg. Enter its path to setup."
    echo "Usage: setup.sh PWNDBG_PATH (e.g: /usr/local/pwndbg/)"
    exit 1
fi


### Setup
# install dependencies in pwndbg venv
"$1/.venv/bin/python3" -m pip install -r requirements.txt

# Build the bundled TypeScript frontend when the JavaScript toolchain is
# available. The legacy page remains as a source-checkout fallback, but a
# production install should serve the Vite bundle from vheapViews/dist.
if command -v pnpm >/dev/null 2>&1; then
  if ! pnpm install --frozen-lockfile || ! pnpm build; then
    echo "Warning: frontend build failed; run 'pnpm install && pnpm build' in $PWD."
  fi
else
  echo "Warning: pnpm is not installed; run 'pnpm install && pnpm build' in $PWD to enable the TypeScript frontend."
fi

echo "source $PWD/vheap.py" >> ~/.gdbinit

echo "vHeap Installed."
