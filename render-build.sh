#!/usr/bin/env bash
# exit on error
set -o errexit

# Instala as dependências normais do projeto
npm install

# Força o download do navegador Chrome oficial do Puppeteer para a nuvem
npx puppeteer browsers install chrome
