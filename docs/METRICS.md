# Метрики для Prometheus и дашборд Grafana

Любой узел может отдавать метрики в формате Prometheus. По умолчанию они
**выключены**. Узел отдаёт не только своё, а **всё, что он видит**: все узлы сети со
своей статистикой, опубликованные устройства, кто их занял, трафик, свои подключения
к чужим устройствам, самообновление. Поэтому достаточно подключить к Prometheus один
узел — по нему видна вся сеть; можно подключить несколько, для надёжности (см.
«Несколько наблюдателей»).

## Как включить

Любым из способов, на каждом узле отдельно:

1. **В интерфейсе узла** — «Настройки» → «Метрики для Prometheus». Галочка включает
   метрики; поле токена необязательно, кнопка «Создать токен» генерирует случайный.
   Токен показывается **один раз** — скопируйте его до нажатия «Сохранить»: на узле
   остаётся только его хеш. Чтобы снять токен, отметьте «снять токен».
2. **Флагом на один запуск** — `start.bat --metrics` (или `node src/main.js --metrics`),
   токен на один запуск — `--metrics-token <строка>`. В файл настроек такие значения
   не пишутся.
3. **В `config.json`** — `"metricsEnabled": true` (токен через файл не задаётся:
   только через интерфейс, чтобы в нём лежал хеш, а не открытая строка).

Метрики отдаются на порту интерфейса (по умолчанию 47812): `GET /metrics`. Включение и
выключение действуют сразу, без перезапуска.

## Кому доступны

| Состояние | Что отвечает `/metrics` |
|---|---|
| Выключено (по умолчанию) | `404` — как будто такого пути нет |
| Включено, токена нет | Только из рабочей сети узла и с него самого; снаружи `403` |
| Включено, токен задан | Откуда угодно, но с заголовком `Authorization: Bearer <токен>`; иначе `401` |

Токен принимается только в заголовке, не в адресе (адрес попадает в журналы).
Метрики показывают всю сеть — имена узлов и устройств, кто что занял, — поэтому за
пределы рабочей сети их отдавайте только с токеном.

## Подключение к Prometheus

```yaml
scrape_configs:
  - job_name: net-device-share
    scrape_interval: 15s
    metrics_path: /metrics
    # если задан токен узла:
    authorization:
      type: Bearer
      credentials: ВАШ_ТОКЕН        # или credentials_file: /etc/prometheus/nds.token
    static_configs:
      - targets: ['192.168.88.11:47812']   # любой узел сети: он отдаёт все
        labels:
          site: lab-1
```

Сбор занимает миллисекунды и не нагружает узел; интервал 15–30 секунд — разумный.

## Дашборд Grafana

Файл [`docs/grafana/net-device-share.json`](grafana/net-device-share.json). Импорт:
Grafana → Dashboards → **New → Import → Upload JSON file**, источник данных —
ваш Prometheus.

Вверху две переменные:

- **Узел-наблюдатель** (`instance`) — чьи метрики показывать. Каждый узел отдаёт всю
  сеть, поэтому панели берут данные одного, а не складывают одно и то же.
- **Узлы** (`node`) — фильтр по узлам сети; по умолчанию все.

Разделы: **Сеть** (узлов, устройств, загрузка, трафик), **Узлы** (таблица со статистикой
по каждому узлу, доступность, занятость, трафик, аптайм, давность ответа, типы устройств),
**Устройства** (занятые, кем, трафик, держатель молчит, ошибки), **Клиенты** (кто сколько
держит и гонит), **Обновления** (версии по сети, состояние самообновления), **Узел-наблюдатель**
(процессор, память, время сбора).

Дашборд собирается скриптом `node scripts/build-grafana-dashboard.mjs`; тест проверяет,
что каждая метрика из его запросов действительно отдаётся приложением. Не править JSON
руками, а менять скрипт.

## Статистика по узлам

Для **каждого** узла сети (включая узел-наблюдатель и не отвечающие) отдаётся:

| Метрика | Смысл |
|---|---|
| `nds_node_info` | адрес, порт, платформа, версия, откуда узел известен (`origin`: `self`, `local`, `seed`, `relay`), круг доверия; всегда 1 |
| `nds_node_up` | 1 — отвечает, 0 — нет |
| `nds_node_last_seen_age_seconds` | сколько секунд назад узел подавал признаки жизни |
| `nds_node_start_time_seconds`, `nds_node_uptime_seconds` | когда запущен и сколько работает |
| `nds_node_state_error` | не удалось получить состояние узла |
| `nds_node_devices{scope}` | устройства узла: `published` — опубликованные, `all` — все |
| `nds_node_devices_busy`, `nds_node_devices_free` | занято и свободно |
| `nds_node_devices_by_type{type}` | по типам: usb, com, lpt, net |
| `nds_node_groups`, `nds_node_holders` | опубликованные группы; сколько разных узлов держат его устройства |
| `nds_node_traffic_bytes_per_minute{direction}` | трафик его устройств за минуту, байт |
| `nds_node_traffic_session_bytes{direction}` | трафик его устройств за текущие занятия |
| `nds_node_local_devices_shared` | только у узла-наблюдателя: сколько локальных устройств опубликовано |

Общее по сети: `nds_nodes{state="online|offline"}`.

## Все метрики

Метки узла везде `node_id` (устойчивый идентификатор) и `node` (имя, может меняться);
метки устройства — `owner_id`, `owner`, `device_id`, `type`, `title`.

**Узел-наблюдатель**

| Метрика | Метки | Смысл |
|---|---|---|
| `nds_build_info` | `node_id`, `node`, `version`, `platform`, `backend`, `network` | сведения об узле, всегда 1 |
| `nds_backend_capability` | `capability` (`server`, `client`) | что умеет бэкенд USB/IP |
| `nds_traffic_meter_enabled` | | включён ли учёт трафика |
| `nds_autostart_enabled` | | включён ли автозапуск |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes` | | память процесса |
| `process_cpu_seconds_total` (счётчик) | | процессорное время |
| `process_start_time_seconds` | | время запуска процесса |
| `nds_scrape_duration_seconds` | | сколько заняла сборка метрик |

**Узлы** — таблица выше (`nds_node_*`, `nds_nodes`).

**Устройства** (все видимые, включая неопубликованные локальные)

| Метрика | Метки | Смысл |
|---|---|---|
| `nds_device_info` | + `description`, `group`, `shared`, `vendor_id`, `product_id` | всегда 1 |
| `nds_device_busy` | | 1 — занято |
| `nds_device_bind_state` | + `state` | состояние у владельца, всегда 1 |
| `nds_device_error` | | у устройства ошибка |
| `nds_device_claim_info` | + `holder_id`, `holder`, `mode` | кто занял (`remote` — чужой узел, `local` — сам владелец) |
| `nds_device_claim_age_seconds` | | сколько занято |
| `nds_device_holder_silent_seconds` | | сколько держатель не продлевал аренду |
| `nds_device_traffic_bytes_per_minute`, `nds_device_traffic_session_bytes` | + `direction` (`in` — к устройству, `out` — от него) | трафик за минуту и за занятие |
| `nds_device_traffic_last_activity_age_seconds`, `nds_device_connections` | | давность обмена, число подключений |

**Группы:** `nds_group_members`, `nds_group_busy`, `nds_group_shared` (метки `owner_id`,
`owner`, `group_id`, `group`).

**Клиенты (держатели)** — кто сколько устройств держит и гонит:
`nds_holder_devices`, `nds_holder_traffic_bytes_per_minute{direction}`,
`nds_holder_traffic_session_bytes{direction}` (метки `holder_id`, `holder`).

**Подключения узла-наблюдателя к чужим устройствам:** `nds_attachment_state{state}`,
`nds_attachment_age_seconds`, `nds_attachment_heartbeat_age_seconds` (метки `owner_id`,
`owner`, `target`, `title`), `nds_attachments_attached`.

**Запросы «освободите устройство»:** `nds_requests_incoming_pending` (к узлу),
`nds_requests_outgoing_pending` (его собственные).

**Самообновление узла-наблюдателя:** `nds_update_info{running,mode,phase}`,
`nds_update_supported`, `nds_update_staged`, `nds_update_trial`,
`nds_update_failed_versions`, `nds_update_reported_bad_versions`.

Замечания по смыслу:

- **Трафик** считается счётчиком на стороне владельца и показывает USB/IP и кадры сетевой
  карты. `..._per_minute` — за последнюю минуту (делите на 60 для байт в секунду),
  `..._session_bytes` — за текущее занятие; при освобождении устройства обнуляется, поэтому
  это не счётчик (`gauge`), и `rate()` к нему применять нельзя. Если у владельца выключен
  учёт трафика, у его устройств метрик трафика нет.
- **Метки с именами** (`node`, `owner`, `title`) удобны для чтения, но имя можно сменить;
  для долгих запросов и оповещений соединяйте по `node_id`/`owner_id`/`device_id`.
- **Кардинальность** невелика: порядка десятков серий на узел и устройство, лабораторная
  сеть — это сотни серий.

## Несколько наблюдателей

Каждый опрашиваемый узел отдаёт ту же сеть, и без выбора все панели показали бы
каждую метрику несколько раз. Поэтому в запросах и в дашборде стоит `instance="$instance"`:
выберите узел-наблюдатель. Несколько наблюдателей полезны только для надёжности — если один
узел выключен, остальные по-прежнему видят сеть. Свои метрики процесса (`process_*`,
`nds_scrape_*`, `nds_update_*`) у каждого узла настоящие собственные.

## Примеры запросов

```promql
# Не отвечающие узлы
nds_node_up == 0

# Занято и свободно по узлам
nds_node_devices_busy
nds_node_devices_free

# Кто больше всех держит устройств
topk(5, nds_holder_devices)

# Трафик сети, байт в секунду
sum(nds_node_traffic_bytes_per_minute) / 60

# Устройства, занятые дольше суток
nds_device_claim_age_seconds > 86400

# Версии в сети: на скольких узлах какая
count by (version) (nds_node_info)
```

## Оповещения (пример для Prometheus)

```yaml
groups:
  - name: net-device-share
    rules:
      - alert: NdsNodeDown
        expr: nds_node_up == 0
        for: 2m
      - alert: NdsHolderSilent
        expr: nds_device_holder_silent_seconds > 20
        for: 30s
        annotations:
          summary: "Держатель {{ $labels.holder_id }} не отвечает на проверку связи"
      - alert: NdsDeviceError
        expr: nds_device_error == 1
        for: 5m
      - alert: NdsUpdateRejected
        expr: nds_update_failed_versions > 0
        for: 1m
```

## Если не работает

- **404** — метрики не включены на этом узле.
- **403** — запрос не из рабочей сети узла, а токена нет: задайте токен.
- **401** — токен не тот или не передан заголовком `Authorization: Bearer`.
- **Пусто в Grafana** — не выбран «Узел-наблюдатель» или Prometheus не видит узел
  (проверьте `up{job="net-device-share"}`).
- **Нет метрик трафика** — у владельца выключен «Считать трафик устройств».
