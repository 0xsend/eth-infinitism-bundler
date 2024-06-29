#!/bin/bash

PRJ_DIR=`dirname $0`/..

DEBUG='aa*' bun run --watch $PRJ_DIR/src/exec.ts --port 3030 \
        --config $PRJ_DIR/localconfig/bundler.config.json \
        --mnemonic $PRJ_DIR/localconfig/mnemonic.txt \
        --network http://localhost:8546 \
        --entryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \
        --beneficiary 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
        --unsafe
