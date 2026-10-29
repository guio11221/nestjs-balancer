# Segurança e limitações

1. **SSRF:** upstreams devem vir apenas de configuração confiável. O guard embutido rejeita origens malformadas/com credenciais, faixas privadas, loopback, link-local, IPv6 e IPv4 mapeado quando habilitado, mas não substitui allowlist de DNS nem proteção contra rebinding. Nunca aceite URL upstream enviada pelo cliente.
2. **Confiança em proxies:** `trustProxy` só deve ser ativado quando a aplicação estiver atrás de proxies controlados. Valide a cadeia de cabeçalhos encaminhados no seu ambiente.
3. **Host:** use `allowedHosts` (exato ou `*.sufixo`) para rejeitar Host inesperado; hosts malformados/divergentes recebem `421` no HTTP/1.
4. **Sticky:** defina `sticky.secret` de alta entropia em múltiplas réplicas; sem ele o token é válido apenas no processo atual.
5. **Autenticação:** o balanceador não autentica usuários nem implementa rate limiting; adicione esses controles antes de expor o gateway.
6. **Request smuggling:** cabeçalhos hop-by-hop e tokens em `Connection` são removidos; ainda assim faça testes específicos de HTTP em proxies múltiplos.
7. **Tráfego sensível:** TLS upstream deve usar verificação padrão de certificado; não desabilite validação de TLS.
8. **DoS:** configure limites de requests, cabeçalhos, conexões e tempo na borda (reverse proxy externo), além de timeouts connect/headers/request/idle. O módulo não implementa cotas de tamanho.
9. **Retry:** limitado a GET/HEAD sem corpo, antes de headers, com orçamento móvel. Repetir POST/PUT/PATCH pode duplicar efeitos e não é permitido.
10. **Shutdown:** configure `shutdownTimeoutMs` e aguarde o dreno; requisições em andamento são abortadas ao final do prazo.
11. **Production readiness:** faltam fuzzing, bench, testes com payload grande, streaming prolongado, stress testing e revisão independente de segurança.

Relate problemas de segurança de forma privada ao mantenedor antes de abrir issue pública.
