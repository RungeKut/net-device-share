# INDEX — маршрутизация по документации

Открывай файл, только если задача попала в колонку «Когда». «Монолит» — большой документ, на который ссылаются README, тесты и релизные ссылки; его не делят, читать по оглавлению (Grep -n, Read offset/limit).

| Файл | Когда |
|---|---|
| [50_status/STATE.md](50_status/STATE.md) | начало сессии; точка возобновления |
| [00_rules/token-economy.md](00_rules/token-economy.md) | планирование работы, запуск субагентов, контекст разросся |
| [00_rules/agents.md](00_rules/agents.md) | постановка задачи агенту |
| [00_rules/compact.md](00_rules/compact.md) | готовимся к компакту |
| [00_rules/git.md](00_rules/git.md) | коммит, push, ветки, релиз |
| [00_rules/code-style.md](00_rules/code-style.md) | пишешь код; правило комментариев |
| [ARCHITECTURE.md](ARCHITECTURE.md) | монолит: устройство, принятые решения, где что менять |
| [PROTOCOL.md](PROTOCOL.md) | монолит: протокол NDS/1, формат пакетов и вызовов |
| [UPDATE.md](UPDATE.md) | монолит: самообновление, подпись, установщик, откат версии |
| [HANDOVER.md](HANDOVER.md) | монолит: передача проекта, что работает и не проверено, грабли, тесты |
| [METRICS.md](METRICS.md) | монолит: метрики Prometheus, оповещения, дашборд Grafana |
| [WINDOWS-SETUP.md](WINDOWS-SETUP.md) | монолит: установка на Windows, драйверы USB/IP |
| [grafana/net-device-share.json](grafana/net-device-share.json) | дашборд Grafana; генерируется `npm run build:grafana`, руками не править |
