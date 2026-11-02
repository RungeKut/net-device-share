// Языки интерфейса, ключевая схема: разметка и шаблоны ссылаются на ключи,
// тексты живут в src/ui/i18n/<код>.js. Код языка попадает в import(), поэтому
// берётся только из реестра LANGS — путь нельзя собрать из данных пользователя.
// Нет перевода в словаре языка — берётся русский, нет ключа — сам ключ, не
// загрузился словарь — работа на английском. Пока переходный период, поверх
// ключей работает прежнее наложение словаря на кириллицу готового DOM (DICT
// ниже) — оно не трогает уже переведённое. Смена языка перезагружает страницу:
// русский текст в DOM обратно не собирается.

import en from './i18n/en.js';
import ru from './i18n/ru.js';

const DICT = {
  // -------------------------------------------------------------- шапка, вкладки
  'подключение…': 'connecting…',
  'связь с приложением': 'connection to the app',
  'раздача': 'share',
  'возможность раздавать свои устройства': 'can share own devices',
  'подключение': 'connect',
  'возможность подключать чужие устройства': 'can connect others’ devices',
  'только просмотр': 'view only',
  'Войти': 'Sign in',
  'Выйти': 'Sign out',
  'Обновить': 'Refresh',
  'Список и так обновляется сам. Нажмите, если доставили usbipd или usbip не перезапуская приложение, если подключали устройство мимо приложения или если только что воткнули переходник и хотите увидеть новый порт сразу.'
    : 'The list refreshes on its own. Click this if you installed usbipd or usbip without restarting the app, attached a device outside the app, or just plugged an adapter in and want to see the new port right away.',
  'Настройки': 'Settings',
  'Устройства сети': 'Network devices',
  'Мои устройства': 'My devices',
  'Группы': 'Groups',
  'Занято мной': 'Taken by me',
  'Занято этим компьютером': 'Taken by this computer',
  'Узлы': 'Nodes',
  'Сеть': 'Network',
  'Журнал': 'Log',
  'Устройства и группы, доступные в сети': 'Devices and groups available on the network',
  'поиск: название, описание, владелец, порт…': 'search: name, description, owner, port…',
  'только свободные': 'free only',
  'все типы': 'all types',
  'Устройства этого компьютера': 'Devices of this computer',
  'публиковать новые автоматически': 'publish new devices automatically',
  'Опубликованное устройство видно другим узлам. Занять его может любой из них — и вы сами.\n      В поле «для чего» напишите, что это за устройство: этот текст видят все.'
    : 'A published device is visible to other nodes. Any of them can take it — and so can you.\n      In the “what for” field describe the device: everyone sees this text.',
  'Группа устройств': 'Device group',
  'Создать группу': 'Create group',
  'Группа — составное устройство. Для отладки платы нужны JTAG и COM сразу, и занимать их\n      по отдельности бессмысленно: между двумя захватами вклинится кто-то третий. Группа занимается целиком.'
    : 'A group is a composite device. Board debugging needs JTAG and COM at once, and taking them\n      separately is pointless: someone else slips in between the two grabs. A group is taken as a whole.',
  'Устройства с пробросом присутствуют в «Диспетчере устройств» так же, как подключённые кабелем.\n      Остальные только числятся за вами — их вы подключаете физически.'
    : 'Forwarded devices appear in Device Manager as if attached by cable.\n      The rest are just booked under your name — you connect to them physically.',
  'Узлы в сети': 'Nodes on the network',
  'Сеть этого компьютера': 'This computer’s network',
  'Создать коммутатор': 'Create switch',
  'Создать виртуальный адаптер': 'Create virtual adapter',
  'Диагностика моста': 'Bridge diagnostics',
  'Что реально происходит в общем мосту: у владельца — трасса ARP/ICMP по портам, у держателя — адреса, маршруты и соседи'
    : 'What actually happens inside the shared bridge: on the owner — ARP/ICMP trace per port, on the holder — addresses, routes and neighbors',
  'Коммутатор соединяет адаптеры этого компьютера как обычный коммутатор — кадрами по MAC.\n      Включите в него физическую карту, и всё подключённое окажется в её сети. Виртуальный адаптер — ещё\n      один сетевой адаптер Windows со своим MAC и адресом: так компьютер выглядит в сети стенда несколькими\n      устройствами. Адаптеры, созданные не приложением (OpenVPN, VirtualBox, сами карты), тоже можно\n      переименовать, отключить, сменить им MAC, программные — удалить, и соединить коммутатором.\n      Здесь же видно, какие карты отданы по сети и какие забронированы.'
    : 'The switch joins this computer’s adapters like a regular switch — frames by MAC.\n      Add a physical NIC, and everything connected lands in its network. A virtual adapter is one more\n      Windows network adapter with its own MAC and address: the bench network then sees this computer as\n      several devices. Adapters not created by the app (OpenVPN, VirtualBox, the NICs themselves) can also\n      be renamed, disabled, given another MAC, and the software ones — removed, all joinable by a switch.\n      This tab also shows which NICs are shared over the network and which are booked.',
  'в одном сегменте (мост, коммутатор)': 'same segment (bridge, switch)',
  'проброс по сети': 'forwarded over network',
  'бронь': 'booking',
  'только бронь': 'booking only',
  'Коммутаторы': 'Switches',
  'Адаптеры': 'Adapters',
  'прокручивать': 'autoscroll',

  // ------------------------------------------------------------------- диалоги
  '⚠ У вас просят устройство': '⚠ Someone asks for your device',
  'Отказать': 'Decline',
  'Отдать': 'Hand over',
  'Если не ответить, запрос истечёт сам через несколько минут.': 'If you don’t answer, the request expires on its own in a few minutes.',
  'Снимок для разбора «мост собран, а до прибора не дойти». Скопируйте и пришлите вместе с журналом.'
    : 'A snapshot for troubleshooting “the bridge is up but the instrument is unreachable”. Copy it and send along with the log.',
  'Копировать': 'Copy',
  'Закрыть': 'Close',
  'Через какую сеть подключаться?': 'Which network to connect through?',
  'Отмена': 'Cancel',
  'Подключиться': 'Connect',
  'Попросить устройство': 'Ask for a device',
  'Сообщение держателю': 'Message to the holder',
  '(необязательно)': '(optional)',
  'например: нужно на 15 минут, сдать прошивку': 'e.g.: need it for 15 minutes to flash firmware',
  'Отправить запрос': 'Send request',
  'Задать адрес адаптеру?': 'Assign an address to the adapter?',
  'Адрес адаптера': 'Adapter address',
  '(можно изменить)': '(editable)',
  'например, 192.168.1.51': 'for example, 192.168.1.51',
  'Нет, оставить без адреса': 'No, leave without an address',
  'Да, задать': 'Yes, assign',
  'Копирование драйвера': 'Copying the driver',
  'Установить': 'Install',
  'Название': 'Name',
  'например: Стенд отладки STM32': 'e.g.: STM32 debug bench',
  'Описание: что это и для чего': 'Description: what it is and what for',
  'JTAG и консоль одной платы; занимать только вместе': 'JTAG and console of one board; take together only',
  'Устройства группы': 'Group devices',
  'Устройства группы публикуются автоматически. Занимать их по отдельности будет нельзя.'
    : 'Group devices are published automatically. Taking them separately will not be possible.',
  'Удалить': 'Delete',
  'Сохранить': 'Save',
  'Вход': 'Sign in',
  'Управление с других компьютеров требует пароля. Он задаётся в настройках\n      на том компьютере, где запущено приложение.'
    : 'Managing from other computers requires a password. It is set in the settings\n      on the computer where the app runs.',
  'Пароль': 'Password',
  'Применить': 'Apply',

  // ---------------------------------------------------------------- настройки
  'Имя этого узла': 'Name of this node',
  'имя компьютера': 'computer name',
  'Под этим именем вас видят остальные и по нему видно, кто занял устройство.'
    : 'Others see you under this name, and it shows who has taken a device.',
  'Рабочая сеть': 'Working network',
  'Какие типы устройств показывать': 'Which device types to show',
  'Запускать как службу при загрузке системы': 'Run as a service at system startup',
  'Создаёт задание планировщика Windows от имени SYSTEM: приложение стартует при\n        загрузке системы, до входа пользователя, и работает у любого вошедшего — в том числе\n        без прав администратора, без запроса UAC. Подтвердить повышение прав нужно один раз — сейчас. Применяется сразу, а не по кнопке «Сохранить».'
    : 'Creates a Windows Scheduler task as SYSTEM: the app starts at boot, before any user\n        signs in, and runs for everyone — including without administrator rights and without a UAC prompt.\n        Elevating needs one confirmation — now. Applies immediately, not via “Save”.',
  'Ставить недостающее при запуске': 'Install missing components at startup',
  'Node.js, usbipd-win и usbip-win2 лежат в каталоге installers и ставятся сами,\n        если их нет в системе. Интернет не нужен: перед установкой сверяются контрольная\n        сумма и подпись. Уже установленное не трогается. Требует прав администратора —\n        запущенное без них приложение покажет запрос UAC.'
    : 'Node.js, usbipd-win and usbip-win2 are kept in the installers folder and install themselves\n        if missing. No internet needed: checksum and signature are verified before installing.\n        What is already installed is left alone. Requires administrator rights —\n        an app without them will show a UAC prompt.',
  'Обновление приложения по сети': 'App updates over the network',
  'Автоматически: ставить, когда безопасно': 'Automatic: install when it is safe',
  'Спрашивать: скачивать, но ставить только с моего разрешения': 'Ask: download, but install only with my approval',
  'Выключено': 'Off',
  'Когда кто-то в сети получает новую версию, остальные скачивают её друг у друга\n        по очереди и перезапускаются, пока никто не работает с их устройствами. Версия проверяется\n        по цифровой подписи; если новая версия не запустится, приложение вернётся к прежней.'
    : 'When someone on the network gets a new version, the others download it from each other\n        in turn and restart while nobody is using their devices. The version is checked\n        against a digital signature; if the new one fails to start, the app rolls back.',
  'Считать трафик устройств': 'Meter device traffic',
  'Показывает скорость обмена (байт в минуту) по каждому устройству.\n        Для этого приложение принимает соединение USB/IP на своём порту и пересылает\n        его службе usbipd, то есть встаёт в тракт данных. Выключение убирает цифры,\n        но и посредника. Изменение требует перезапуска.'
    : 'Shows the transfer rate (bytes per minute) for each device.\n        For that, the app accepts the USB/IP connection on its own port and forwards\n        it to the usbipd service, i.e. stands in the data path. Turning it off removes\n        the numbers and the middleman. Changing this requires a restart.',
  'Метрики для Prometheus': 'Metrics for Prometheus',
  'токен доступа (необязательно)': 'access token (optional)',
  'Создать токен': 'Create token',
  'снять токен': 'clear token',
  'Выключено по умолчанию. Включённый узел отдаёт на порту интерфейса адрес\n        /metrics — не только своё, а всё, что он видит: все узлы сети со статистикой,\n        устройства, кто их занял, трафик. Достаточно подключить к Prometheus один узел.\n        Без токена метрики отдаются только из рабочей сети; с токеном — откуда угодно, с заголовком\n        Authorization: Bearer <токен>. Токен хранится хешем и показывается только\n        при создании: скопируйте его до сохранения.'
    : 'Off by default. An enabled node serves /metrics on its UI port —\n        not only itself but everything it sees: all network nodes with statistics,\n        devices, who has taken them, traffic. Connecting a single node to Prometheus is enough.\n        Without a token, metrics are served only from the working network; with one — from anywhere,\n        with the Authorization: Bearer <token> header. The token is stored hashed and shown\n        only at creation: copy it before saving.',
  'Пароль для доступа с других компьютеров': 'Password for access from other computers',
  'Пусто — оставить как есть. Чтобы снять пароль, введите один символ «-».\n        Без пароля с других компьютеров доступен только просмотр.'
    : 'Empty — keep as is. To remove the password, enter a single “-”.\n        Without a password, other computers get view-only access.',
  'Сети с общим ключом': 'Networks with a shared key',
  'Добавить сеть': 'Add network',
  'Узел состоит сразу во всех перечисленных сетях, и в каждой его видят только те,\n        у кого тот же ключ. Название — ваше, оно нигде не передаётся и служит подписью в\n        списке узлов. Ключ годится любой печатаемый, не короче 8 символов; пробелы по краям\n        отбрасываются — они невидимы, а из-за них узлы молча перестают видеть друг друга.\n        Сравнивается посимвольно, поэтому на всех компьютерах ключ должен совпадать в\n        точности. Кнопка «Ключ» даёт 125 случайных бит без похожих друг на друга знаков\n        (без O и 0, I и 1), так что его можно продиктовать. Сохранённый ключ больше не\n        показывается: пустое поле означает «оставить прежний».'
    : 'The node joins every listed network at once, and in each one only those\n        with the same key see it. The name is yours, it is never sent anywhere and serves\n        as a label in the node list. Any printable key of at least 8 characters works; spaces\n        at the edges are dropped — they are invisible yet make nodes silently stop seeing each other.\n        The key is compared character by character, so it must match exactly\n        on every computer. The “Key” button gives 125 random bits without look-alike characters\n        (no O and 0, I and 1), so you can read it out loud. A saved key is never\n        shown again: an empty field means “keep the old one”.',
  'Видеть узлы без ключа': 'See keyless nodes',
  'Показывать компьютеры, на которых ключ не задан, и пользоваться их устройствами.\n        Выключение скрывает их из списка. Учтите: не объявляя себя, попросить соседей\n        представиться нельзя, поэтому тихий узел без ключа появится не сразу, а с его\n        очередным анонсом.'
    : 'Show computers with no key set and use their devices.\n        Turning this off hides them from the list. Note: without announcing itself,\n        a quiet keyless node cannot be asked to identify, so it appears not immediately\n        but with its next announcement.',
  'Быть видимым для узлов без ключа': 'Be visible to keyless nodes',
  'Объявлять себя тем, у кого ключа нет: они увидят этот компьютер, его\n        опубликованные устройства и смогут их запрашивать. Выключение делает узел невидимым\n        для всех, кроме своих сетей. Настройки независимы — можно видеть, не показываясь,\n        и наоборот.'
    : 'Announce yourself to those without a key: they will see this computer, its\n        published devices, and be able to request them. Turning this off makes the node invisible\n        to everyone except its own networks. The settings are independent — you can see without\n        being seen, and the other way around.',
  'Срок аренды, с': 'Lease time, s',
  'Подробность журнала': 'Log level',
  'Порт HTTP': 'HTTP port',
  'Порт обнаружения (UDP)': 'Discovery port (UDP)',
  'Узлы в других сетях': 'Nodes in other networks',
  'Обнаружение по UDP не выходит за пределы подсети: broadcast не\n        маршрутизируется, multicast в корпоративных сетях обычно тоже. Укажите здесь адрес\n        одного узла из другой сети — приложения обменяются списками и расскажут о них своим\n        соседям. Настроить достаточно одну сторону.'
    : 'UDP discovery does not leave the subnet: broadcast is not\n        routed, multicast usually is not either in corporate networks. Enter the address\n        of one node from another network — the apps exchange lists and tell their\n        neighbors about it. Configuring one side is enough.',
  'Адреса, по одному в строке': 'Addresses, one per line',
  'Требуется общий ключ: за пределами своей подсети он единственное, что отличает\n          свой узел от чужого. Через указанный узел идёт только знакомство — устройства,\n          занятость и сами данные USB/IP каждый забирает у владельца напрямую.'
    : 'A shared key is required: beyond your own subnet it is the only thing telling\n          your nodes from strangers. Only introductions go through the listed node — devices,\n          occupancy and the USB/IP data itself each fetch from the owner directly.',
  'Обмен списками, с': 'List exchange, s',
  'Опрос этих узлов, с': 'Poll these nodes, s',
  'Анонсов от них не слышно, поэтому об изменениях спрашиваем сами.'
    : 'No announcements are heard from them, so we ask about changes ourselves.',
  'Темп анонсов': 'Announcement pace',
  'Анонс присутствия получает каждый компьютер подсети. Пока состояние\n        меняется, узел объявляется часто; в покое интервал сам растёт до медленного и трафик\n        падает на порядок. Любое изменение мгновенно возвращает быстрый темп.'
    : 'Every computer in the subnet receives the presence announcement. While state\n        changes, the node announces often; when idle the interval grows to the slow one\n        and traffic drops by an order of magnitude. Any change instantly restores the fast pace.',
  'Обычный интервал, с': 'Regular interval, s',
  'В покое, с': 'When idle, s',
  'Замедляться в покое': 'Slow down when idle',
  'Выключение возвращает прежнее поведение — ровный темп независимо от того,\n          происходит что-нибудь или нет.'
    : 'Turning this off restores the old behavior — a steady pace regardless of\n          whether anything is happening.',
  'Канал': 'Transport',
  'оба (надёжнее)': 'both (more reliable)',
  'только multicast': 'multicast only',
  'только broadcast': 'broadcast only',
  'По умолчанию оба: где-то режут multicast, где-то broadcast. Если точно известно,\n          какой работает, второй — это ровно вдвое больше пакетов впустую.\n          Изменение применяется сразу.'
    : 'Both by default: some networks cut multicast, others broadcast. If you know exactly\n          which one works, the second one is exactly twice the wasted packets.\n          The change applies immediately.',
  'Пути к утилитам USB/IP': 'Paths to USB/IP tools',
  'usbipd (раздача)': 'usbipd (sharing)',
  'usbip (подключение)': 'usbip (connecting)',
  'определяется автоматически': 'detected automatically',
  'автоматически': 'auto',

  // -------------------------------------------------------------- коммутатор
  'Новый коммутатор': 'New switch',
  'Имя': 'Name',
  'например: Стенд': 'e.g.: Bench',
  'Карта — выход в её сеть': 'NIC — uplink to its network',
  'Без карты коммутатор внутренний: соединяет только адаптеры этого компьютера. Две карты —\n        это две сети, слитые в одну; так делают, только когда это и нужно. Кроме физических карт, в мост\n        входят и программные адаптеры других программ (VirtualBox и т. п.).'
    : 'Without a NIC the switch is internal: it joins only this computer’s adapters. Two NICs\n        mean two networks merged into one; do that only when it is the point. Besides physical NICs,\n        software adapters of other programs (VirtualBox etc.) can join the bridge too.',
  'Адаптеры, которые уже есть, — подключить к коммутатору': 'Existing adapters — connect to the switch',
  'TAP-адаптеры: созданные здесь и чужие (OpenVPN и т. п.). Чужой адаптер, пока он подключён,\n        другая программа открыть не может — его можно отпустить в любой момент.'
    : 'TAP adapters: created here and foreign ones (OpenVPN etc.). While a foreign adapter is\n        connected, other programs cannot open it — you can release it at any moment.',
  'Оставить этому компьютеру доступ к сети карты': 'Keep this computer connected to the NIC’s network',
  'Адрес карты переедет на адаптер «Сетевой мост» — компьютер останется в сети под тем же\n        адресом. Без галочки на мосту не будет IP: сеть карты — только для подключённых адаптеров.'
    : 'The NIC’s address moves to the “Network bridge” adapter — the computer stays on the network\n        under the same address. Without the checkbox the bridge gets no IP: the NIC’s network is\n        for the connected adapters only.',
  'Создать': 'Create',
  'Новый виртуальный адаптер': 'New virtual adapter',
  'Имя в «Сетевых подключениях»': 'Name in “Network Connections”',
  'Коммутатор': 'Switch',
  'MAC-адрес': 'MAC address',
  'свой у адаптера (не менять)': 'the adapter’s own (keep)',
  'случайный': 'random',
  'задать…': 'set…',
  'заводской': 'factory',
  'Настройки IP': 'IP settings',
  'выключен — сам компьютер в сети карты не участвует': 'off — the computer itself is not part of the NIC’s network',
  'включён': 'on',

  // ------------------------------------------------------------------ net.js
  'частная': 'private',
  'общедоступная': 'public',
  'доменная': 'domain',
  'физическая карта': 'physical NIC',
  'адаптер моста — этот компьютер': 'bridge adapter — this computer',
  'виртуальный адаптер': 'virtual adapter',
  'выход коммутатора в сеть': 'switch uplink',
  'мост отданной карты': 'shared NIC’s bridge',
  'чужая карта у вас': 'someone’s NIC at your side',
  'TAP-адаптер другой программы': 'another program’s TAP adapter',
  'программный адаптер': 'software adapter',
  'TAP-адаптер другой программы, в коммутаторе': 'another program’s TAP adapter, in a switch',
  'адаптер Hyper-V': 'Hyper-V adapter',
  'создан не приложением': 'not created by the app',
  'не подключён': 'not connected',
  'в мосту — адрес у моста': 'bridged — the address is on the bridge',
  'IP выключен': 'IP off',
  'DHCP, адреса нет': 'DHCP, no address',
  'адреса нет': 'no address',
  'не прочитаны': 'not read',
  'нет адреса': 'no address',
  'нет связи': 'no link',
  'отключён': 'disabled',
  'Общедоступная сеть: сетевой экран (и Windows, и Kaspersky) режет входящие — приборы стенда не достучатся до серверов на этом компьютере'
    : 'Public network: the firewall (Windows and Kaspersky alike) blocks incoming — bench instruments cannot reach servers on this computer',
  'Частная сеть: входящие соединения разрешены правилами для частных сетей'
    : 'Private network: incoming connections are allowed by the private-network rules',
  'готовится к выдаче': 'being prepared',
  'опубликована': 'published',
  'Карта не пробрасывается: держатель работает с ней на этом компьютере'
    : 'The NIC cannot be forwarded: the holder works with it on this computer',
  'занял карту — у него адаптер': 'took the NIC — has an adapter',
  'забронировал карту': 'booked the NIC',
  'работает на этом компьютере': 'works on this computer',
  'проброс': 'forward',
  'Мост Windows': 'Windows bridge',
  'коммутатор · мост Windows': 'switch · Windows bridge',
  'мост, собранный не приложением': 'a bridge not built by the app',
  'IP на мосту выключен': 'IP is off on the bridge',
  'занявший': 'taker',
  'занял карту — канал подключён': 'took the NIC — link connected',
  'занял карту — канал ждёт подключения': 'took the NIC — link waiting to connect',
  'коммутатор · мост не собран': 'switch · no bridge',
  'внутренний коммутатор': 'internal switch',
  'владелец': 'owner',
  'карта': 'NIC',
  'проброс — связь потеряна': 'forward — link lost',
  'рабочая': 'in use',
  'общедост.': 'public',
  'адрес держателя': 'holder’s address',
  'настройки поменял держатель брони; вернутся при освобождении': 'settings changed by the booking holder; restored on release',
  'Читается состав сети…': 'Reading the network composition…',
  'Отключить компьютер от сети': 'Disconnect the computer from the network',
  'Подключить компьютер к сети': 'Connect the computer to the network',
  'Добавить карту': 'Add NIC',
  'Выход в сеть карты': 'Uplink to the NIC’s network',
  'внешний — в сети карты': 'external — on the NIC’s network',
  'внутренний': 'internal',
  'вывести карту из коммутатора': 'remove the NIC from the switch',
  'убрать': 'remove',
  'да': 'yes',
  'нет': 'no',
  '(чужой)': '(foreign)',
  'Включить IP': 'Turn IP on',
  'Выключить IP': 'Turn IP off',
  'Входящие соединения из этой сети станут разрешены правилами для частных сетей'
    : 'Incoming connections from this network will be allowed by the private-network rules',
  'Сделать сеть частной': 'Make the network private',
  'этой карте': 'this NIC',
  'этом адаптере': 'this adapter',
  'Включить': 'Enable',
  'Отключить': 'Disable',
  'Вывести из коммутатора: адаптер снова свободен для своей программы'
    : 'Remove from the switch: the adapter is free again for its own program',
  'Отпустить': 'Release',
  'через эту карту работает приложение': 'the app works through this NIC',
  'адрес задал держатель брони': 'the address was set by the booking holder',
  'канал подключён': 'link connected',
  'канал ждёт владельца': 'link waiting for the owner',
  'занят другим!': 'taken by someone else!',
  'адреса, объявленные в сеть владельца (gratuitous ARP)': 'addresses announced into the owner’s network (gratuitous ARP)',
  'Коммутаторов нет. «Создать коммутатор» — чтобы подключить виртуальные адаптеры к сети карты или друг к другу.'
    : 'No switches yet. “Create switch” — to join virtual adapters to a NIC’s network or to each other.',
  'Шлюз': 'Gateway',
  'необязательно': 'optional',
  'через запятую, необязательно': 'comma-separated, optional',
  'От типа сети зависит, пустит ли сетевой экран к этому компьютеру ping и соединения к вашим серверам.'
    : 'The network category decides whether the firewall lets ping and connections to your servers through to this computer.',
  'впишите хотя бы один адрес или выберите DHCP': 'enter at least one address or choose DHCP',
  'Применяется…': 'Applying…',
  'Настройки применены': 'Settings applied',
  'в мост не включается': 'cannot join a bridge',
  'Свободных карт нет — будет внутренний коммутатор.': 'No free NICs — the switch will be internal.',
  'TAP-адаптеров, которые можно подключить, нет. Новый — кнопкой «Создать виртуальный адаптер».'
    : 'No TAP adapters to connect. Create one with “Create virtual adapter”.',
  'Две карты в одном коммутаторе — это две сети, слитые в одну. Убедитесь, что это и нужно.'
    : 'Two NICs in one switch mean two networks merged into one. Make sure that is the intent.',
  'Связь на карте прервётся на несколько секунд, пока собирается мост.'
    : 'The NIC’s link drops for a few seconds while the bridge is assembled.',
  'Внутренний коммутатор: соединяет только адаптеры этого компьютера.'
    : 'Internal switch: joins only this computer’s adapters.',
  'Собирается мост — это до минуты…': 'Assembling the bridge — up to a minute…',
  'Создаётся коммутатор, подключаются адаптеры…': 'Creating the switch, connecting the adapters…',
  'Создаётся коммутатор…': 'Creating the switch…',
  'Коммутатор создан': 'Switch created',
  'Драйвер TAP принимает только локальные MAC-адреса — первый байт 02, 06, 0A…'
    : 'The TAP driver accepts only locally administered MAC addresses — first byte 02, 06, 0A…',
  'Заводской адрес настоящей карты (00-15-…) он не примет.'
    : 'It will not accept a real NIC’s factory address (00-15-…).',
  'Драйвер обычно принимает любой одноадресный MAC; не примет — адаптер останется со своим,'
    : 'The driver usually accepts any unicast MAC; if not, the adapter keeps its own,',
  'и вы увидите ошибку. Смена MAC перезапускает адаптер: связь на нём прервётся на несколько секунд.'
    : 'and you will see an error. Changing the MAC restarts the adapter: its link drops for a few seconds.',
  'не подключать — отпустить адаптер': 'don’t connect — release the adapter',
  'не подключать': 'don’t connect',
  '(в сети карты)': '(on the NIC’s network)',
  'Этот адаптер входит в коммутатор мостом Windows, как карта: связь на нём прервётся на несколько секунд, и всё, что подключено к коммутатору, окажется в его сети.'
    : 'This adapter joins the switch via the Windows bridge, like a NIC: its link drops for a few seconds, and everything connected to the switch lands in its network.',
  'Адаптер создан не приложением. Подключённый к коммутатору, он занят приложением: другая программа (например, OpenVPN) открыть его не сможет, пока вы его не отпустите. Сеть адаптера станет «частной».'
    : 'This adapter was not created by the app. Connected to a switch, it is held by the app: another program (OpenVPN, say) cannot open it until you release it. The adapter’s network becomes “private”.',
  'Адаптер создан не приложением. «Не подключать» — отпустить его: он снова будет свободен для своей программы.'
    : 'This adapter was not created by the app. “Don’t connect” releases it: its own program can use it again.',
  '— задан вместо заводского': '— set instead of the factory one',
  'Меняется мост — это до минуты…': 'Changing the bridge — up to a minute…',
  'Меняется адаптер…': 'Changing the adapter…',
  'Готово': 'Done',
  'Создаётся адаптер — до минуты…': 'Creating the adapter — up to a minute…',
  'Адаптер создан': 'Adapter created',
  'Адаптер включён': 'Adapter enabled',
  'Адаптер отключён': 'Adapter disabled',
  'Адаптер отпущен': 'Adapter released',
  'Адаптер удалён': 'Adapter removed',
  'Адаптер подключён': 'Adapter connected',
  '(OpenVPN, VirtualBox…), она перестанет работать, пока не создаст его заново. Адаптер исчезнет из Windows вместе с настройками.'
    : '(OpenVPN, VirtualBox…), it will stop working until it recreates it. The adapter disappears from Windows along with its settings.',
  'Новое имя коммутатора': 'New switch name',
  'Отключить этот компьютер от сети карты? На мосту выключится IP.'
    : 'Disconnect this computer from the NIC’s network? IP on the bridge will turn off.',
  'Мост разберётся, карта вернётся к своим настройкам.'
    : 'The bridge is dismantled and the NIC returns to its own settings.',
  'Коммутатор удаляется…': 'Removing the switch…',
  'Коммутатор удалён': 'Switch removed',
  'Карта в коммутаторе': 'NIC in a switch',
  'карту': 'NIC',
  'Карта выведена': 'NIC removed',
  'Адаптер моста отданной карты: это сам компьютер в сети карты. Адрес задайте свой — не тот, что у занявшего. При освобождении карты настройки моста вернутся к прежним.'
    : 'The shared NIC’s bridge adapter: this is the computer itself on the NIC’s network. Set your own address — not the taker’s. When the NIC is released, the bridge settings return as they were.',
  'Адаптер моста — это сам компьютер в сети коммутатора.'
    : 'The bridge adapter is the computer itself on the switch’s network.',
  'Виртуальный адаптер: проверка адреса на дубликат у него выключена — в одном коммутаторе несколько адаптеров компьютера иначе гасили бы друг другу адреса.'
    : 'Virtual adapter: duplicate-address checking is off for it — otherwise several of the computer’s adapters in one switch would fight over addresses.',
  'Выключить IP на адаптере моста? Этот компьютер перестанет быть в сети карты.'
    : 'Turn IP off on the bridge adapter? This computer will leave the NIC’s network.',
  'IP на мосту включён': 'IP turned on for the bridge',
  'IP на мосту выключен': 'IP turned off for the bridge',
  'Настройки IP — ': 'IP settings — ',
  'Адаптер «': 'Adapter “',

  // ------------------------------------------------------------- app.js: пилюли
  'свободно': 'free',
  'готовится к выдаче…': 'being prepared…',
  'занимается': 'being taken',
  'занимается…': 'taking…',
  'занято': 'taken',
  'занято вами · ': 'taken by you · ',
  'освобождается…': 'releasing…',
  'ошибка': 'error',
  'придержано за ': 'held for ',
  'в мосту: ': 'bridged: ',
  'моё': 'mine',
  'моя': 'mine',
  'владелец офлайн': 'owner offline',
  'занята частично': 'partially taken',
  'не все устройства на месте': 'some devices are missing',
  'опубликовано, свободно': 'published, free',
  'не опубликовано': 'not published',
  'опубликована, свободна': 'published, free',
  'отдано группой': 'shared via group',
  'в группе (не опубл.)': 'in a group (unpublished)',
  'готовится к выдаче': 'being prepared',
  'своё устройство': 'own device',
  'в общем мосту': 'in the shared bridge',
  'вне приложения': 'outside the app',
  'своё': 'own',
  '→ бронь': '→ booking',
  '→ подключается': '→ connecting',
  'порт VHCI ': 'VHCI port ',
  'адаптер «': 'adapter “',
  'шлюз': 'gateway',
  '🌉 шлюз': '🌉 gateway',
  'Этот узел стоит в нескольких сетях и работает шлюзом: пересказывает каталог и при необходимости пропускает соединения из одной сети в другую'
    : 'This node sits in several networks and acts as a gateway: it relays the catalog and, when needed, passes connections from one network to another',
  'другая сеть': 'other network',
  'в сети': 'online',
  'не отвечает': 'not responding',
  'чужая сеть': 'foreign network',
  'Этот узел объявляет чужую для нас сеть, а слышен здесь: его анонсы проходят через NAT или туннель,'
    : 'This node announces a network foreign to us yet is heard here: its announcements come through NAT or a tunnel,',
  'и напрямую его порты недоступны. Свяжитесь с ним через «Узлы в других сетях» и проброс портов на его хосте'
    : 'and its ports are not reachable directly. Reach it via “Nodes in other networks” and port forwarding on its host',
  'круг доверия ': 'trust circle ',
  'сеть: ': 'network: ',
  'Нажмите на узел, чтобы открыть его интерфейс в новой вкладке.'
    : 'Click a node to open its interface in a new tab.',
  'Других узлов в сети не найдено.': 'No other nodes found on the network.',
  'Открыть интерфейс узла в новой вкладке': 'Open the node’s interface in a new tab',
  'узнан из каталога': 'learned via catalog',
  'через USB-переходник': 'via a USB adapter',
  'состояние: ': 'state: ',
  'адреса: ': 'addresses: ',
  'ид: ': 'id: ',
  'с/н: ': 'S/N: ',

  // --------------------------------------------------------- app.js: действия
  'Занять': 'Take',
  'Забронировать': 'Book',
  'Освободить': 'Release',
  'Забрать себе': 'Take back',
  'Просто освободить': 'Just release',
  'Попросить': 'Ask',
  'Подключиться в мост': 'Join to bridge',
  'Выйти из моста': 'Leave the bridge',
  'Опубликовать': 'Publish',
  'Снять с публикации': 'Unpublish',
  'Изменить': 'Edit',
  'Изменить…': 'Edit…',
  'К коммутатору…': 'To a switch…',
  'Вывести из коммутатора': 'Remove from switch',
  'В коммутатор ': 'Into switch ',
  'Копировать драйвер': 'Copy driver',
  'Настройки IP': 'IP settings',
  'Задать ': 'Assign ',
  'Скрыть': 'Hide',
  'Повторить установку': 'Retry installation',
  'Обновить сейчас': 'Update now',
  'Повторить': 'Retry',
  'Откатиться': 'Roll back',
  'Только бронирование: приложение запишет, что устройство за вами, но в системе оно не появится — подключаться к нему нужно физически'
    : 'Booking only: the app records that the device is yours, but it will not appear in the system — connect to it physically',
  'Это USB-адаптер: опубликуйте его как USB-устройство — и оно пробросится целиком, '
    : 'This is a USB adapter: publish it as a USB device and it will be forwarded whole, ',
  'с его COM-портом у занявшего.': 'with its COM port at the taker’s side.',
  'На этом компьютере появится сетевой адаптер, подключённый к сети за картой владельца. Первое занятие занимает до минуты: владелец собирает мост'
    : 'A network adapter will appear on this computer, connected to the network behind the owner’s NIC. The first take takes up to a minute: the owner assembles the bridge',
  'У владельца откроется настоящий COM-порт, а на этом компьютере появится виртуальный порт с тем же именем: приложение будет работать с ним, как с локальным. Параметры возьмутся как у владельца'
    : 'The owner gets their real COM port working, and a virtual port with the same name appears on this computer: your app uses it like a local one. Settings are taken from the owner',
  'Устройство появится в «Диспетчере устройств» этого компьютера'
    : 'The device will appear in this computer’s Device Manager',
  'Проброса нет: ': 'No forwarding: ',
  'Проброса нет: приложение учитывает, кто занял устройство, но данные по сети не передаёт. Подключаться к нему нужно физически.'
    : 'No forwarding: the app records who has taken the device but passes no data over the network. Connect to it physically.',
  'Приложение учитывает, кто занял устройство, но данные по сети не передаёт.'
    : 'the app records who has taken the device but does not pass any data over the network.',
  'но данные по сети не передаёт. Подключаться к нему нужно физически.'
    : 'the app records who has taken the device but passes no data over the network. Connect to it physically.',
  'Это USB-адаптер: он же есть в списке USB-устройств. Опубликуйте его как USB-устройство — '
    : 'This is a USB adapter: it is also in the USB device list. Publish it as a USB device — ',
  'тогда оно пробросится целиком, и его COM-порт появится у того, кто занял.'
    : 'then it will be forwarded whole, and its COM port will appear at the taker’s side.',
  'Через эту карту приложение ищет узлы (автоматический выбор сетей), поэтому пробросить её нельзя. '
    : 'The app searches for nodes through this NIC (automatic network selection), so it cannot be forwarded. ',
  'Чтобы можно было: отметьте у карты в «Моих устройствах» «Не использовать для обнаружения» '
    : 'To make it possible: mark “Don’t use for discovery” on the NIC in “My devices” ',
  'или выберите основную сеть вручную в настройках. Тогда приложение перестанет работать в этой сети и потеряет в ней соседей.'
    : 'or pick the primary network manually in the settings. The app will then stop working on that network and lose its neighbors there.',
  'Через эту карту работает само приложение: отдав её, компьютер потеряет связь с остальными узлами.'
    : 'The app itself works through this NIC: sharing it would cut the computer off from the other nodes.',
  'На этом компьютере появится адаптер в сети владельца. Владелец остаётся в ней под своим адресом, карта остаётся доступной остальным узлам.'
    : 'An adapter on the owner’s network will appear on this computer. The owner stays in it under their own address, and the NIC remains available to other nodes.',
  'У владельца статический адрес ': 'The owner has a static address ',
  'вам предложим ': 'we will offer you ',
  'Карта подключена в общий мост: эти узлы работают в сети владельца одновременно. '
    : 'The NIC is joined into a shared bridge: these nodes work on the owner’s network simultaneously. ',
  'Скорость каждого — обмен за последнюю минуту. Подключиться может любой ещё.'
    : 'Each one’s rate is the traffic of the last minute. Anyone else may join too.',
  'Поменять настройки вашего адаптера этой карты': 'Change the settings of your adapter for this NIC',
  'Карта в брони: попросить владельца поменять её настройки — при освобождении вернутся прежние'
    : 'The NIC is booked: ask the owner to change its settings — they will be restored on release',
  'Взять у владельца драйвер этого устройства и установить его на этом компьютере'
    : 'Fetch this device’s driver from the owner and install it on this computer',
  'Откроется окно настроек с предложенным адресом — останется нажать «Сохранить»'
    : 'The settings window will open with a suggested address — just press “Save”',
  'Имя порта владельца здесь занято': 'The owner’s port name is taken here',

  // --------------------------------------------------------- app.js: карточки
  'владелец: ': 'owner: ',
  'подключено: ': 'connected: ',
  'адаптер у вас: ': 'your adapter: ',
  'порт VHCI: ': 'VHCI port: ',
  'настройки IP не перенесены: ': 'IP settings not applied: ',
  'настройки карты у владельца заданы вами — ': 'the owner’s NIC settings were set by you — ',
  'ваши настройки — ': 'your settings — ',
  'настройки как у карты владельца — ': 'settings as on the owner’s NIC — ',
  'IPv4: не настроен': 'IPv4: not configured',
  'Под фильтр ничего не подходит.': 'Nothing matches the filter.',
  'Опубликованных устройств в сети пока нет.<br>Опубликуйте своё на вкладке «Мои устройства» или дождитесь других узлов.'
    : 'No published devices on the network yet.<br>Publish yours on the “My devices” tab or wait for other nodes.',
  'Устройства не обнаружены. Проверьте, какие типы включены в настройках.'
    : 'No devices found. Check which types are enabled in the settings.',
  'Групп пока нет. Объедините устройства, которые имеет смысл занимать только вместе.'
    : 'No groups yet. Group the devices that make sense to take together only.',
  'Сейчас этот компьютер ничего не занимает.': 'This computer has nothing taken at the moment.',
  'Нет свободных устройств: все уже состоят в других группах.'
    : 'No free devices: all already belong to other groups.',
  'Коммутатор для этого адаптера…': 'A switch for this adapter…',
  'Коммутатор на ': 'A switch on ',
  'Скорость не показывается: у владельца выключен учёт трафика.'
    : 'No rate shown: the owner has traffic metering off.',
  'скорость: ': 'rate: ',
  'занял': 'took',
  'устройств.': 'devices',
  'устройств': 'devices',
  'группа · ': 'group · ',

  // ------------------------------------------------------- app.js: занятия
  'источник: ': 'source: ',
  'связь с владельцем: ': 'link to owner: ',
  'назад': 'ago',
  'держатель не отвечает ': 'the holder is not responding ',
  '· освободится через ': '· will be released in ',
  'Держатель не присылает проверку связи. Если связь не вернётся, аренда кончится и устройство освободится само.'
    : 'The holder sends no heartbeat. If the link does not return, the lease ends and the device is released on its own.',
  'откроется его интерфейс': 'its interface opens',
  '— туннель (прямого маршрута нет)': '— tunnel (no direct route)',
  '— маршрут есть, идём напрямую': '— a route exists, going directly',
  '— способ ещё проверяется': '— still checking how',
  'напрямую в вашей сети': 'directly on your network',
  'напрямую': 'directly',
  ', туннель': ', tunnel',
  ', напрямую': ', directly',
  'через шлюз «': 'via gateway “',
  '»': '”',
  'Узел «': 'Node “',
  '» виден из нескольких сетей. Выберите, через какую выполнить подключение.'
    : '” is seen from several networks. Choose which one to connect through.',
  'Запрос отправлен держателю': 'Request sent to the holder',
  'Запрос отправлен ': 'Request sent ',
  'Скопировано': 'Copied',
  'Не удалось скопировать — выделите текст вручную': 'Copy failed — select the text manually',
  'Забрать устройство себе? Тот, кто с ним работает, потеряет соединение без предупреждения.'
    : 'Take the device back? Whoever works with it loses the connection without warning.',
  'Устройство у вас': 'The device is yours',
  'Освобождено': 'Released',
  'Освободить принудительно? Тот, кто с ним работает, потеряет соединение.'
    : 'Force-release? Whoever works with it loses the connection.',
  'Подключено в мост: адаптер появится в «Сетевых подключениях»'
    : 'Joined to the bridge: an adapter will appear in “Network Connections”',
  'Забронировано. В системе устройство не появится: подключайтесь к нему физически'
    : 'Booked. The device will not appear in the system: connect to it physically',
  'Группа опубликована': 'Group published',
  'Группа снята с публикации': 'Group unpublished',
  'Группа удалена': 'Group deleted',
  'Группа сохранена': 'Group saved',
  'Группа опубликована: её устройства занимаются только целиком и не публикуются по отдельности.'
    : 'The group is published: its devices are taken as a whole only and cannot be published separately.',
  'Группа не опубликована: её устройства ведут себя как обычные — публикуются и занимаются по отдельности.'
    : 'The group is not published: its devices behave like regular ones — published and taken separately.',
  'Описание сохранено': 'Description saved',
  'Автозапуск включён': 'Autostart enabled',
  'Автозапуск выключен': 'Autostart disabled',
  'Устройство отдано': 'Device handed over',
  'В запросе отказано': 'Request declined',
  'Полный доступ получен': 'Full access granted',
  'Настройки сохранены': 'Settings saved',
  'Сохранено. Изменения портов и ключа вступят в силу после перезапуска.'
    : 'Saved. Port and key changes take effect after a restart.',
  'Проверьте выделенное поле — значение вне допустимых пределов.'
    : 'Check the highlighted field — the value is out of range.',
  'Изменение группы': 'Edit group',
  'Новая группа': 'New group',
  'ждём ответа': 'waiting for an answer',
  'отдано вам — занимайте': 'handed to you — take it',
  'освободилось': 'released',
  'отказано': 'declined',
  'истёк без ответа': 'expired unanswered',
  'владелец забрал себе': 'the owner took it back',
  'Приложение не будет искать узлы и объявляться в сети этой карты. Карту можно будет пробросить; соседи из этой сети пропадут из списка.'
    : 'The app will stop searching for nodes and announcing itself on this NIC’s network. The NIC becomes forwardable; neighbors on that network disappear from the list.',
  'Карта исключена из обнаружения — её можно пробросить': 'The NIC is excluded from discovery — it can be forwarded',
  'Карта снова участвует в обнаружении': 'The NIC takes part in discovery again',

  // --------------------------------------------------------- app.js: обновление
  'Проверка обновления': 'Checking for updates',
  'Скачивание обновления': 'Downloading the update',
  'Обновление в очереди': 'Update queued',
  'Обновление готово к установке': 'Update ready to install',
  'Доступно обновление': 'Update available',
  'Перезапуск для обновления': 'Restarting to update',
  'Проверка новой версии': 'Checking a new version',
  'Нужен установщик': 'Installer needed',
  'Обновление не удалось': 'Update failed',
  'Версия сообщена как испорченная': 'Version reported as corrupted',
  'Обновление…': 'Updating…',
  'Откат…': 'Rolling back…',
  'Откатиться на предыдущую версию? Приложение перезапустится, подключения к устройствам оборвутся, а нынешняя версия будет помечена плохой на этом компьютере.'
    : 'Roll back to the previous version? The app restarts, device connections drop, and the current version will be marked bad on this computer.',
  'Перезапустить приложение сейчас? Подключения к устройствам, которые вы занимаете или отдаёте, оборвутся.'
    : 'Restart the app now? Connections to devices you take or share will drop.',
  'Ни у одного из соседей нет установщика для раздачи — возьмите его у администратора.'
    : 'None of the neighbors has the sharing installer — get it from the administrator.',
  'Если у вас всё работает, можно ничего не делать; если нет — откатитесь на предыдущую.'
    : 'If everything works, do nothing; if not, roll back to the previous one.',
  'Всё равно установить': 'Install anyway',
  'Устанавливаю…': 'Installing…',
  'установлен': 'installed',
  'не установлен': 'not installed',
  'Драйвер установлен': 'Driver installed',
  'Драйвер установить не удалось': 'Failed to install the driver',
  'Скопировать драйвер не получилось': 'Could not copy the driver',
  'Если устройство уже подключено, Windows подхватит драйвер сама; если нет — освободите устройство и займите его снова.'
    : 'If the device is already connected, Windows picks the driver up itself; if not — release the device and take it again.',
  'Внимание: подпись драйвера не подтверждена.': 'Warning: the driver signature is not verified.',
  '64-битная Windows, скорее всего, откажется его ставить — тогда ниже будет сообщение системы. Если же поставит,'
    : '64-bit Windows will most likely refuse to install it — the system message will appear below. If it does install,',
  'вы запустите код с правами ядра от неизвестного издателя. Продолжайте, только если доверяете владельцу'
    : 'you will run kernel-level code from an unknown publisher. Continue only if you trust the owner',
  'устройства «': 'of device “',
  'Идёт установка компонентов USB/IP…': 'Installing USB/IP components…',
  'Windows запросит права администратора — подтвердите. Запрос приходит на каждый компонент отдельно; в окне видно издателя установщика. Это может занять около минуты.'
    : 'Windows will ask for administrator rights — confirm. The prompt comes per component; the window shows the installer’s publisher. This may take about a minute.',
  'подготовка…': 'preparing…',
  'Окружение USB/IP настроено не полностью': 'The USB/IP environment is not fully set up',
  'Готово: всё необходимое установлено.': 'Done: everything needed is installed.',
  'Окружение перепроверено, ограничения сняты.': 'The environment has been re-checked and the limits lifted.',
  'МБ из папки ': 'MB from the folder ',
  ', интернет не нужен.': ', no internet needed.',
  'Потребуются права администратора: Windows спросит подтверждение на каждый компонент.'
    : 'Administrator rights will be needed: Windows asks for confirmation per component.',
  'Режим просмотра.': 'View-only mode.',
  'Каталог и занятость видны полностью. Чтобы занимать и публиковать устройства, нажмите «Войти» и введите пароль.'
    : 'The catalog and occupancy are fully visible. To take and publish devices, press “Sign in” and enter the password.',
  'Управление с других компьютеров закрыто: пароль не задан. Задайте его в настройках на том компьютере, где запущено приложение.'
    : 'Managing from other computers is closed: no password is set. Set one in the settings on the computer where the app runs.',
  'Свои USB-устройства можно публиковать': 'Own USB devices can be published',
  'Серверная часть USB/IP не найдена — публикация USB недоступна': 'The USB/IP server part is missing — USB sharing unavailable',
  'Чужие USB-устройства можно подключать': 'Others’ USB devices can be connected',
  'Клиентская часть USB/IP не найдена — подключение USB недоступно': 'The USB/IP client part is missing — USB connecting unavailable',
  'Токен создан: скопируйте его сейчас и нажмите «Сохранить» — потом он не покажется'
    : 'Token created: copy it now and press “Save” — it will not be shown again',
  '•••••• (токен задан)': '•••••• (token set)',
  '•••••• (задан)': '•••••• (set)',
  'не задан — извне только просмотр': 'not set — view-only from outside',
  'на этой системе автозапуск не поддерживается': 'autostart is not supported on this system',
  'Поиск узлов только в этой сети; карты остальных можно пробрасывать.'
    : 'Searching for nodes on this network only; other NICs can be forwarded.',
  '(только бронь)': '(booking only)',
  'Ни одной сети с ключом.': 'No key-protected networks.',
  'Узел работает только в открытом круге — там, где ключ не проверяется.'
    : 'The node works only in the open circle — where no key is checked.',
  'название сети': 'network name',
  'ключ задан — оставьте пустым': 'key set — leave empty',
  'введите или создайте ключ': 'enter or create a key',
  'Создать случайный ключ': 'Generate a random key',
  'Удалить сеть': 'Remove network',
  'ключ создан: скопируйте его сейчас, после сохранения он не показывается'
    : 'key created: copy it now, it is not shown after saving',
  'новая сеть': 'new network',
  'Узел не состоит ни в одном круге: он никого не видит'
    : 'The node belongs to no circle: it sees no one',
  'и никому не виден. Заведите сеть с ключом или включите открытый круг.'
    : 'and no one sees it. Create a key-protected network or enable the open circle.',
  'узлы без ключа видим': 'keyless nodes visible',
  'узлы без ключа не видим': 'keyless nodes hidden',
  'им видны': 'we are visible to them',
  'им не видны': 'we are hidden from them',
  'Адреса указаны, но узел не состоит ни в одном круге: включите «узлы без ключа» или задайте ключ сети — иначе обмен выключен.'
    : 'Addresses are set but the node belongs to no circle: enable “keyless nodes” or set a network key — otherwise exchange is off.',
  'Адреса не указаны — работаем только в своей подсети.': 'No addresses set — we work on our own subnet only.',
  'ещё не опрошен': 'not polled yet',
  'тихо': 'silent',
  'ни одного': 'none',
  'подпись верна': 'signature valid',
  'подпись не прошла проверку': 'signature failed verification',
  'не подписан': 'unsigned',
  'Запрашиваю драйвер у владельца устройства и проверяю подпись. Это может занять до минуты…'
    : 'Fetching the driver from the device owner and checking its signature. This can take up to a minute…',
  ', версия ': ', version ',
  'Остальное подставится из сети владельца: ': 'The rest will come from the owner’s network: ',
  'пусто': 'empty',
  'Не прошли проверку на этом компьютере: ': 'Failed verification on this computer: ',
  '— пользуйтесь каталогом: ': '— use the catalog: ',

  // ------------------------------------------------------------------ серверные фразы
  'устройство занято узлом ': 'the device is taken by node ',
  'устройство сейчас занято — сначала освободите его': 'the device is taken right now — release it first',
  'не опубликовано': 'not published',
  'устройство не найдено': 'device not found',
  'группа не найдена': 'group not found',
  'занято другим узлом': 'taken by another node',
  'устройство занято: ': 'the device is taken: ',
  'запрос не найден': 'request not found',
  'на запрос уже ответили': 'the request has already been answered',
  'отвечать может только держатель': 'only the holder can answer',
  'цель свободна — занимайте без запроса': 'the target is free — take it without a request',
  'вы и так держите эту цель': 'you already hold this target',
  'аренда истекла': 'the lease has expired',
  'нет прав': 'not allowed',
  'право на интерфейс больше не действует': 'the right to the interface is no longer valid',
  'владелец не принял соединение — право на интерфейс больше не действует'
    : 'the owner rejected the connection — the right to the interface is no longer valid',
  'занять не удалось': 'could not take it',

  // ----------------------------------------------------------- единицы и время
  'только что': 'just now',
  ' мин': ' min',
  ' ч': ' h',
  ' дн': ' d',
  'с назад': 'sec ago',
  'мин назад': 'min ago',
  'ч назад': 'h ago',
  'дн назад': 'd ago',
  'Б/мин': 'B/min',
  'КБ/мин': 'KB/min',
  'МБ/мин': 'MB/min',
  'ГБ/мин': 'GB/min',
  'Б': 'B',
  'КБ': 'KB',
  'МБ': 'MB',
  'ГБ': 'GB',
  'За последнюю минуту принято ': 'Received in the last minute: ',
  ', передано ': ', sent ',
  '. Всего за сеанс: ': '. Total for the session: ',
  'принято ': 'received ',
  'передано ': 'sent ',
  'и ещё ': 'and ',
  'ещё ': 'more ',

  // ------------------------------------------------------------- прочее общее
  'нет': 'no',
  'да': 'yes',
  'на': 'on',
  'владелец ': 'owner ',
  'приложение': 'the app',
  'Устройство сеть ': 'The network of the device ',
};

/** Порядок проверяемых фраз: длинные раньше коротких, иначе короткие
 *  съедали бы куски длинных и перевод ломался. */
const ORDERED = Object.keys(DICT).sort((a, b) => b.length - a.length);

const RULES = ORDERED
  .filter((k) => /[А-ЯЁа-яё]/.test(k))
  .map((k) => [new RegExp('(?<![А-ЯЁа-яё])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![А-ЯЁа-яё])', 'g'), DICT[k]]);

// «5 с» — длительность, а «с серверами» — предлог: секунда только после цифры.
RULES.push([/(?<=[0-9]) с(?![А-ЯЁа-яё])/g, ' sec']);

/** Словарь целиком — для проверок целостности. */
export function dictEntries() {
  return Object.entries(DICT);
}

// ------------------------------------------------------------- реестр языков
const LANGS = {
  en: 'English',
  ru: 'Русский',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  'es-MX': 'Español (Latinoamérica)',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
  tr: 'Türkçe',
  sv: 'Svenska',
  nb: 'Norsk bokmål',
  da: 'Dansk',
  fi: 'Suomi',
  uk: 'Українська',
  ar: 'العربية',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  fil: 'Filipino',
  sw: 'Kiswahili',
};
const RTL = new Set(['ar']);

const dicts = { en, ru };

function isLang(code) {
  return typeof code === 'string' && Object.hasOwn(LANGS, code);
}

/** Реестр для переключателя языка в шапке. */
export function languages() {
  return Object.entries(LANGS).map(([code, name]) => ({ code, name, dir: RTL.has(code) ? 'rtl' : 'ltr' }));
}

let lang = 'en';
try {
  const saved = localStorage.getItem('nds-lang');
  lang = isLang(saved) ? saved : 'en';
} catch { /* приватный режим — просто язык по умолчанию */ }

/** Перевод готовой строки. Вне английского текст не трогается. */
export function translateText(text) {
  if (lang !== 'en' || !text || !/[А-ЯЁа-яё]/.test(text)) return text;
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  if (/[А-ЯЁа-яё]/.test(out) && !MISSING.has(text)) MISSING.add(text);
  return out;
}

const MISSING = new Set();

/** Что осталось непереведённым — для разбора вместе с человеком. */
export function missingStrings() {
  return [...MISSING].sort();
}

export function getLang() {
  return lang;
}

/**
 * Сменить язык. Перезагрузка нужна потому, что русский текст в DOM
 * из английского не восстанавливается, а перерисовка из русских
 * шаблонов вернёт исходное.
 */
export function setLang(next) {
  if (isLang(next)) {
    try {
      localStorage.setItem('nds-lang', next);
    } catch { /* приватный режим — язык доживёт до перезагрузки */ }
  }
  location.reload();
}

// hasOwn: ключ вроде 'constructor' не должен вытянуть метод прототипа.
function pick(dict, key) {
  return dict && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

export function t(key, params) {
  const text = pick(dicts[lang], key) ?? pick(dicts.ru, key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (token, name) => (
    Object.hasOwn(params, name) && params[name] != null ? String(params[name]) : token
  ));
}

function walkText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const to = translateText(node.nodeValue);
    if (to !== node.nodeValue) node.nodeValue = to;
  }
}

function walkAttrs(root) {
  for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]')) {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const to = translateText(v);
      if (to !== v) el.setAttribute(attr, to);
    }
  }
}

export function translateDom(root = document.body) {
  if (lang !== 'en' || !root) return;
  walkText(root);
  walkAttrs(root);
}

let observer = null;
let scheduled = false;

/** Ключи из разметки: data-i18n="ключ" и data-i18n-placeholder/title/aria-label. */
function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const key = el.getAttribute(`data-i18n-${attr}`);
      if (key) el.setAttribute(attr, t(key));
    }
  }
}

/**
 * Следить за изменениями DOM и переводить появляющееся. Свои правки не
 * зацикливаются: на время прохода наблюдатель отключается.
 */
export async function startI18n() {
  if (!dicts[lang]) {
    try {
      dicts[lang] = (await import('./i18n/' + lang + '.js')).default;
    } catch {
      lang = 'en';
    }
  }
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  applyStatic();
  translateDom();
  if (lang !== 'en') return;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      observer.disconnect();
      try {
        translateDom();
      } finally {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
      }
      if (MISSING.size) console.debug('[i18n] непереведённые строки:', missingStrings());
    }, 50);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
}
