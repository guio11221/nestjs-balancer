# Contribuindo

1. Faça fork e crie branch `feat/<assunto>` ou `fix/<assunto>`.
2. Mantenha a API pública tipada em `src/index.ts` e não exponha detalhes internos sem justificativa.
3. Adicione testes para casos saudáveis e falhas; execute `npm run check`.
4. Atualize README, SECURITY e CHANGELOG quando houver mudança de comportamento.
5. Prefira Node core para a camada HTTP; evite dependências em runtime sem necessidade.
6. Quebras de API exigem versão major; funcionalidades compatíveis, minor; correções, patch.
7. Não inclua segredos, chaves nem hosts reais nos fixtures.
