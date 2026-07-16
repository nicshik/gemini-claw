# Разворачивание на Hermes (без OpenClaw)

Как поставить Antigravity CLI (`agy`) и скиллы `antigravity_ask` /
`antigravity_image` на сервер **Hermes** — Telegram-агент Ника на Python
(`hermes-agent`), который запускает `codex exec` и не имеет никакого OpenClaw.

Гайд написан по результатам анализа боевого хоста Hermes ([адрес хоста скрыт],
Ubuntu 24.04) и репозитория `hermes` от 2026-07-16. Все пути и ограничения ниже —
проверенные факты, не предположения.

## Что переносится, а что нет

| Часть gemini-claw | На Hermes |
|---|---|
| Установка `agy` под сервисным пользователем + симлинк в PATH | Переносится (шаги 2–3) |
| `scripts/login.sh` (OAuth Google AI Pro через tmux) | Работает как есть с `OPENCLAW_USER=hermes` |
| Скиллы `skills/antigravity_ask`, `skills/antigravity_image` (`runtimes: codex`) | Переносятся с двумя правками: обёртки и доставка файлов (шаги 5–6) |
| Плагин-пульт `plugin/index.js` (`/antigravity` меню, кнопки) | **Не переносится** — это OpenClaw plugin SDK; аналог пришлось бы писать на Python внутри `hermes_agent` |
| `scripts/setup.sh`, `install.sh`, `preflight.sh`, `healthcheck.sh` | **Не подходят** — падают без CLI `openclaw` (проверка `OPENCLAW_BIN`) |
| Хелпер `bin/agy-models` + таймер | Не нужен (он обслуживает меню пульта); ставить не обязательно |

## Чем Hermes отличается от хоста OpenClaw

Факты, вокруг которых построены шаги:

- Бот — systemd-юнит `hermes-agent`: `User=hermes` (home `/home/hermes`),
  код в `/opt/hermes-agent`, `WorkingDirectory=/srv/hermes-agent/workspace`.
- Юнит **жёстко захардён**: `ProtectSystem=strict`, `ProtectHome=read-only`,
  запись разрешена только в `ReadWritePaths=/srv/hermes-agent /var/lib/hermes-agent
  /home/hermes/.codex`. `agy` пишет OAuth-токен и артефакты в `~/.gemini` —
  без drop-in с `ReadWritePaths=/home/hermes/.gemini` генерация из бота упадёт
  на записи (шаг 4). Снаружи юнита (root/ssh) ограничения не действуют,
  поэтому установка и логин работают до drop-in.
- `PATH` юнита включает `/usr/local/bin` — симлинк `/usr/local/bin/agy` виден
  боту (там же уже живёт `codex`).
- `codex exec` запускается с `--sandbox danger-full-access` (переменная
  `CODEX_SANDBOX` в `/etc/hermes-agent/telegram.env`) — процессы codex
  ограничивает только systemd-hardening, отдельной песочницы нет.
- Деплой Hermes (`scripts/deploy_hermes.py`) льёт `workspace/bin/` по rsync
  **с `--delete`** — всё, что положить туда мимо репозитория `hermes`, сотрётся
  при следующем деплое. Каталоги `workspace/skills/<имя>/` синкаются
  поимённо (antic, image_gen, …), поэтому новые каталоги скиллов деплой не
  трогает. Отсюда правило: **скиллы — в `workspace/skills/`, обёртки — в
  `/usr/local/bin/`** (обе локации переживают деплой Hermes).
- Картинки в Telegram Hermes доставляет **только из каталога задачи**
  (Hermes передаёт его в промпте строкой «Каталог для файлов этой задачи:
  <путь>» и после задачи сканирует его). `gen.py` пишет в
  `$OPENCLAW_WORKSPACE_DIR/outputs/antigravity-skill-images/` и печатает
  `IMAGE: <путь>` — codex должен скопировать эти файлы в каталог задачи
  (шаг 6), иначе картинка сгенерируется, но в чат не уедет.
- Команда `/skill <имя>` в Hermes принимает только имена из реестра
  `SKILL_CATALOG` в `hermes_agent/config.py` (репозиторий `hermes`). И этого
  мало: `workspace/AGENTS.md` жёстко направляет все задачи на картинки в
  штатный `image_gen` («For image generation/editing … use the `image_gen`
  skill»), поэтому codex игнорирует даже явное «через antigravity_image» в
  тексте задачи и уходит в `./bin/image-gen` (проверено живым тестом
  2026-07-16: ответ «ключ не настроен» от image_gen). Правки репозитория
  `hermes` из шага 7 — **обязательная часть** развёртывания, без них скилл
  недостижим из бота.
- На хосте уже есть `tmux`, `curl`, `git`; свободного диска ~4 ГБ — на `agy`
  хватает.

У Hermes уже есть скилл `image_gen` (Gemini API по ключу `GEMINI_API_KEY`, с
пометражным биллингом). `antigravity_image` закрывает ту же потребность через
подписку Google AI Pro по OAuth — без API-ключа и биллинга.

## Шаг 0. Предпосылки

- root-доступ по SSH на хост Hermes.
- Аккаунт **Google AI Pro** для OAuth (лучше выделенный, не основной — см.
  раздел Security в README).
- Развёрнутый стек Hermes (юнит `hermes-agent` активен).

## Шаг 1. Клонировать репозиторий на хост

```bash
git clone https://github.com/nicshik/gemini-claw /root/gemini-claw
cd /root/gemini-claw
```

Обновления потом — `git pull`, как и для OpenClaw-хостов.

## Шаг 2. Установить agy под пользователем hermes

Официальный установщик, от имени `hermes` (не root):

```bash
sudo -u hermes env HOME=/home/hermes PATH=/usr/local/bin:/usr/bin:/bin \
  bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
ln -sfn /home/hermes/.local/bin/agy /usr/local/bin/agy
sudo -u hermes env HOME=/home/hermes agy --version
```

Важно: команды под `hermes` запускать через `sudo -u hermes env HOME=/home/hermes …`
(или `runuser -u hermes -- env HOME=/home/hermes …`), но **не** `sudo -E` —
`sudo -E` протаскивает root-овый `$HOME`, и agy/codex пишут состояние не туда.

## Шаг 3. OAuth Google AI Pro

`scripts/login.sh` не зависит от OpenClaw (переменная называется
`OPENCLAW_USER` по историческим причинам — это просто сервисный пользователь):

```bash
sudo OPENCLAW_USER=hermes scripts/login.sh
```

Скрипт печатает URL — открой его в локальном браузере, войди в аккаунт AI Pro,
вставь код обратно. Это единственный ручной шаг; токен ляжет в
`/home/hermes/.gemini` и никуда не копируется.

Проверка:

```bash
sudo -u hermes env HOME=/home/hermes bash -c \
  'timeout 90 /usr/local/bin/agy -p "Reply with exactly: OK" </dev/null'
```

## Шаг 4. Разрешить юниту запись в ~/.gemini

Логин уже создал `/home/hermes/.gemini`, теперь открываем его боту (drop-in,
основной юнит-файл не трогаем — его перезаписывает деплой Hermes, а
`service.d/` деплой не трогает):

```bash
mkdir -p /etc/systemd/system/hermes-agent.service.d
cat > /etc/systemd/system/hermes-agent.service.d/antigravity.conf <<'EOF'
[Service]
# agy (Antigravity CLI) держит OAuth-токен и артефакты в ~/.gemini
ReadWritePaths=/home/hermes/.gemini
EOF
systemctl daemon-reload
systemctl restart hermes-agent
systemctl is-active hermes-agent
```

## Шаг 5. Установить скиллы и обёртки

Каталоги скиллов — в workspace (переживают деплой Hermes, см. выше):

```bash
cp -r /root/gemini-claw/skills/antigravity_ask /root/gemini-claw/skills/antigravity_image \
  /srv/hermes-agent/workspace/skills/
chown -R hermes:hermes /srv/hermes-agent/workspace/skills/antigravity_ask \
  /srv/hermes-agent/workspace/skills/antigravity_image
```

Обёртки — в `/usr/local/bin` (в `workspace/bin` нельзя: деплой Hermes льёт его
с `--delete`). Родные обёртки из `skills/bin/` ищут скрипт относительно себя,
поэтому для Hermes пишем свои, с зашитым workspace:

```bash
cat > /usr/local/bin/antigravity-image <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/srv/hermes-agent/workspace}"
exec python3 /srv/hermes-agent/workspace/skills/antigravity_image/scripts/gen.py "$@"
EOF
cat > /usr/local/bin/antigravity-ask <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec python3 /srv/hermes-agent/workspace/skills/antigravity_ask/scripts/ask.py "$@"
EOF
chmod 0755 /usr/local/bin/antigravity-image /usr/local/bin/antigravity-ask
```

`OPENCLAW_WORKSPACE_DIR` направляет вывод `gen.py` в
`/srv/hermes-agent/workspace/outputs/antigravity-skill-images/` (юниту туда
можно писать; каталог самоочищается до 20 последних файлов).

## Шаг 6. Дописать в SKILL.md правила для Hermes

Установленные SKILL.md написаны под OpenClaw-пути и не знают про доставку
через каталог задачи. Дописываем (в **установленные** копии; исходники в
`/root/gemini-claw` не трогаем):

```bash
cat >> /srv/hermes-agent/workspace/skills/antigravity_image/SKILL.md <<'EOF'

## Hermes

- Запускай обёртку по абсолютному пути: `/usr/local/bin/antigravity-image …`
  (путь `~/.openclaw/workspace/bin/...` выше — для OpenClaw, здесь его нет).
- Hermes доставляет в Telegram только файлы из каталога задачи (он передан в
  промпте строкой «Каталог для файлов этой задачи: <путь>»). После генерации
  скопируй каждый файл из строк `IMAGE: <путь>` в этот каталог:
  `cp "<путь из IMAGE:>" "<каталог задачи>/"`.
- Не утверждай, что картинка готова и отправлена, пока файл не лежит в
  каталоге задачи.
EOF

cat >> /srv/hermes-agent/workspace/skills/antigravity_ask/SKILL.md <<'EOF'

## Hermes

- Запускай обёртку по абсолютному пути: `/usr/local/bin/antigravity-ask …`
  (путь `~/.openclaw/workspace/bin/...` выше — для OpenClaw, здесь его нет).
EOF
```

## Шаг 7 (обязательно). Маршрутизация и регистрация в репозитории hermes

Без этого шага скиллы из бота недостижимы: `workspace/AGENTS.md` направляет
все задачи на картинки в штатный `image_gen`, и codex игнорирует упоминание
`antigravity_image` в тексте (см. выше). В репозитории `hermes` нужно:

- `workspace/AGENTS.md` — добавить исключение к правилу про картинки (явный
  запрос Antigravity/agy/Nano Banana → `/usr/local/bin/antigravity-image`,
  скопировать `IMAGE:`-пути в каталог задачи) и описать оба скилла в разделе
  «Selected skills»;
- `hermes_agent/config.py` — добавить в `SKILL_CATALOG`:
  `"antigravity_image": "картинки через Antigravity (agy, Nano Banana 2) по подписке Google AI Pro"`,
  `"antigravity_ask": "вопрос модели через Antigravity CLI (agy)"`;
  при желании — алиасы в `SKILL_ALIASES` (`"agy"`, `"antigravity"`, `"nano-banana"`)
  и пункт в `SKILL_MENU_ITEMS`;

и задеплоить Hermes штатным `scripts/deploy-hermes.sh` (он же перезапустит
юнит). Референс: PR `hermes#127`. Это правка другого репозитория, поэтому в
gemini-claw она не автоматизирована.

## Шаг 8. Проверка

```bash
# 1) agy отвечает под hermes (текст, без трат картиночной квоты)
sudo -u hermes env HOME=/home/hermes bash -c \
  'timeout 90 /usr/local/bin/agy -p "Reply with exactly: OK" </dev/null'

# 2) обёртка собирается и видит agy/окружение — без обращения к сети
sudo -u hermes env HOME=/home/hermes /usr/local/bin/antigravity-image --dry-run "test"

# 3) юнит жив и ReadWritePaths подхвачен
systemctl show hermes-agent -p ReadWritePaths --value   # должен содержать /home/hermes/.gemini
```

Живой тест из Telegram (тратит одну единицу картиночной квоты):
отправь боту «сделай через antigravity_image картинку: маленький матовый чёрный
куб на светло-сером фоне, без текста» — в ответ должно прийти фото.

## Эксплуатация

- **Деплой Hermes** ничего из установленного не трогает: `agy` и токен — в
  `/home/hermes/{.local,.gemini}`, обёртки и симлинк — в `/usr/local/bin`,
  drop-in — в `service.d/`, каталоги `skills/antigravity_*` деплой не синкает.
  Единственное исключение — если когда-нибудь эти скиллы добавят в rsync-список
  `deploy_hermes.py`, источником правды станет репозиторий `hermes`.
- **Обновление**: `cd /root/gemini-claw && git pull`, затем повторить шаги 5–6
  (копирование скиллов + дописка Hermes-секций).
- **Квоты**: у картинок (Nano Banana 2) отдельная квота от текстовых моделей;
  `429 RESOURCE_EXHAUSTED` — подождать (окно ~5 часов), `503` — перегруз на
  стороне Google, не квота. `gen.py` различает оба случая и печатает причину.
- **Безопасность**: токен — переносимый bearer в `/home/hermes/.gemini`;
  компрометация хоста = компрометация аккаунта (отзывать у Google). Любой чат
  из `ALLOWED_CHAT_IDS` может гонять agy и тратить квоту — список держать узким.

## Удаление

```bash
systemctl stop hermes-agent
rm -f /usr/local/bin/agy /usr/local/bin/antigravity-image /usr/local/bin/antigravity-ask
rm -rf /srv/hermes-agent/workspace/skills/antigravity_ask \
       /srv/hermes-agent/workspace/skills/antigravity_image \
       /srv/hermes-agent/workspace/outputs/antigravity-skill-images
rm -f /etc/systemd/system/hermes-agent.service.d/antigravity.conf
rmdir /etc/systemd/system/hermes-agent.service.d 2>/dev/null || true
systemctl daemon-reload
# токен и сам agy (по желанию):
rm -rf /home/hermes/.gemini /home/hermes/.local/bin/agy
systemctl start hermes-agent
```

После удаления не забудь отозвать доступ приложения в аккаунте Google, если
токеном больше не пользуешься.
