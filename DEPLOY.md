# Публікація на Render

Цей проєкт можна зробити доступним з мобільного інтернету без ZeroTier. На Render він отримає публічну HTTPS-адресу, а iPhone зможе встановити його через Safari.

## 1. Створи GitHub-репозиторій

1. Відкрий https://github.com/new
2. Створи репозиторій, наприклад `lviv-transit-pwa`.
3. Завантаж у нього файли проєкту:

```text
server.js
package.json
package-lock.json
Dockerfile
.dockerignore
render.yaml
README.md
DEPLOY.md
public/
```

Не завантажуй `node_modules/` і `.cache/` — це тимчасові файли.

Якщо користуєш GitHub через браузер, можна натиснути **Add file → Upload files** і завантажити вказані файли. Якщо є GitHub Desktop — скопіюй папку проєкту в репозиторій і зроби commit.

## 2. Створи Blueprint на Render

1. Відкрий https://render.com і увійди через GitHub.
2. Натисни **New → Blueprint**.
3. Вибери репозиторій `lviv-transit-pwa`.
4. У поле **Blueprint Path** впиши `render.yaml` або залиш його порожнім. **Не вставляй туди ZIP-архів** — Render вважає ZIP-файл YAML і показує помилку `control characters are not allowed`.
5. Натисни **Apply** / **Create Blueprint**.

Проєкт уже налаштований на:

- Docker;
- безкоштовний план `free`;
- регіон Frankfurt;
- health-check `/api/health`.

## 3. Зачекай на URL

Після успішного деплою Render покаже посилання на кшталт:

```text
https://lviv-transit-pwa.onrender.com
```

Перевір, що відкривається:

```text
https://твій-домен.onrender.com/api/health
```

Має повернути JSON із `"ok": true`.

## 4. Встанови на iPhone

1. Відкрий публічне HTTPS-посилання в **Safari**.
2. Натисни **Поділитися**.
3. Вибери **На екран Home**.
4. Дозволи геолокацію, коли з'явиться запит.

Після цього сайт працюватиме через звичайний мобільний інтернет. ZeroTier не потрібен.

## Автоматичні оновлення

Коли в GitHub зробити новий commit, Render автоматично передеплоїть застосунок. PWA перевіряє нову версію при відкритті, появі мережі та поверненні додатка на екран.

На безкоштовному Render сервіс може «заснути» після 15 хвилин без запитів. Тому перше відкриття після паузи може тривати приблизно 30–60 секунд. Це нормально для безкоштовного плану.
