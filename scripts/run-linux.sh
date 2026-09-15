#!/usr/bin/env bash
# Запуск Net Device Share на Linux.
#
# Модули ядра и операции bind/attach требуют root, поэтому скрипт при
# необходимости перезапускает себя через sudo.

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите версию 20.6 или новее." >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Требуются права root — перезапуск через sudo…"
  exec sudo -E "$0" "$@"
fi

# usbip_host — раздача своих устройств, vhci_hcd — подключение чужих.
# Отсутствие модуля не фатально: приложение честно покажет, какая роль недоступна.
modprobe usbip_host 2>/dev/null || echo "предупреждение: модуль usbip_host не загрузился — раздача будет недоступна" >&2
modprobe vhci_hcd  2>/dev/null || echo "предупреждение: модуль vhci_hcd не загрузился — подключение будет недоступно" >&2

# Демон usbipd обслуживает входящие подключения USB/IP на порту 3240.
if command -v usbipd >/dev/null 2>&1 && ! pgrep -x usbipd >/dev/null 2>&1; then
  usbipd -D || echo "предупреждение: не удалось запустить usbipd" >&2
fi

exec node src/main.js "$@"
