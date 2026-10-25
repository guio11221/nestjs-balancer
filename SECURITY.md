# Segurança e limitações

1. **SSRF:** upstreams devem vir apenas de configuração confiável. Impor allowlist de domínios/IPs em aplicações que aceitam configuração remota. Nunca aceite URL upstream enviada pelo cliente.
2. **Confiança em proxies:** `trustProxy` só deve ser ativado quando a aplicação estiver atrás de proxies controlados. Valide a cadeia de cabeçalhos encaminhados no seu ambiente.
3. **Autenticação:** o balanceador não autentica usuários nem implementa rate limiting; adicione esses controles antes de expor o gateway.
4. **Request smuggling:** cabeçalhos hop-by-hop e tokens em `Connection` são removidos; ainda assim faça testes específicos de HTTP em proxies múltiplos.
5. **Tráfego sensível:** TLS upstream deve usar verificação padrão de certificado; não desabilite validação de TLS.
6. **DoS:** configure limites de requests, cabeçalhos, conexões e tempo na borda (reverse proxy externo). O módulo não implementa essas cotas.
7. **Retry:** ausente por segurança: repetir POST/PUT/PATCH pode duplicar efeitos.
8. **Production readiness:** faltam fuzzing, bench, testes de integração com payload grande, streaming prolongado, conexões interrompidas e stress testing.

Relate problemas de segurança de forma privada ao mantenedor antes de abrir issue pública.
