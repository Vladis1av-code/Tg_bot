require("dotenv").config();
const adminsData = require("./admins"); // test
const groups = require("./groups");
const axios = require("axios");
const { Telegraf, Markup } = require("telegraf");
const regions = require("./regions");
let websites = {};
try {
    websites = require("./websites");
} catch (e) {
    console.warn("⚠️ ./websites not found, continuing without website links");
}
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);
const OWNER_ID = Number(process.env.OWNER_ID);
let userMap = {};
let adminSendState = null; // { awaiting: true }
let devText = "Розробники бота: @Sev1x1";
let devEditState = null; // { awaiting: true }

// =====================
// Перевірка адміна
// =====================

//function isAdmin(ctx) {
//   return ctx.from?.id === ADMIN_ID;
//}

function isOwner(ctx) {
    return ctx.from?.id === OWNER_ID;
}

function isAdmin(ctx) {
    const id = ctx.from?.id;
    return id === ADMIN_ID || adminsData.isAdmin(id);
}


// =====================
// Безпечна відправка повідомлень
// =====================
async function safeSend(fn) {
    try {
        await fn();
    } catch (e) {
        const code = e?.response?.error_code;
        if (code === 403) {
            console.log("🚫 Користувач заблокував бота");
        } else {
            console.error("❌ Помилка Telegram:", e);
        }
    }
}
// =====================
// Пошук міста/області
// =====================
function findLocationLink(text) {
    if (!text) return null;
    if (!websites || Object.keys(websites).length === 0) return null;
    const normalized = text.trim().toLowerCase();
    for (const key of Object.keys(websites)) {
        if (key.toLowerCase() === normalized) {
            return { name: key, url: websites[key] };
        }
    }
    return null;
}

// =====================
// /start
// =====================
bot.start(async (ctx) => {

    if(isOwner(ctx))
    {
        await safeSend(() =>
            ctx.reply(
                "👑 Панель владельца\n\n" +
                "/start – запустити бота\n" +
                "/place_admin — вибрати місто\n" +
                "/send — розіслати повідомлення\n" +
                "/stats — статистика\n" +
                "/users — список пользователей\n"+
                "/setdev - змінити список розробників\n" +
                "/website_admin — адміністрування сайтів\n" +
                "/dev — Розробники бота\n" +
                "/add_admin ID — добавить админа\n" +
                "/remove_admin ID — удалить админа\n" +
                "/admins — список админов\n\n" +
                "/test - test dev"
            )
        );
    }
    else if (isAdmin(ctx)) {
        await safeSend(() =>
            ctx.reply(
                "Админ-панель\n\n" +
                "/start – запустити бота\n" +
                "/place_admin — вибрати місто\n" +
                "/send — розіслати повідомлення\n" +
                "/website_admin — адміністрування сайтів\n" +
                "/dev — Розробники бота\n"
            )
        );
    } else {
        await safeSend(() =>
            ctx.reply(
                "Вітаємо!\n\n" +
                "Цей бот допоможе вам швидко дізнатися графік відключень електроенергії.\n\n" +
                "*Доступні команди:*\n" +
                "/start – запустити бота\n" +
                "/help - тех підтримка\n" +
                "/place - вибрати місто\n" +
                "/website - офіційний сайт\n" +
                "/dev - Розробники бота\n",
                { parse_mode: "Markdown" }
            )
        );
        const uid = ctx.from?.id;
        if (uid) {
            const existing = userMap[uid];
            userMap[uid] = userMap[uid] || {
                firstName: ctx.from?.first_name || {},
                lastName: ctx.from?.last_name || {},
                username: ctx.from?.username ? `@${ctx.from.username}` : {},
                phone: {},
            };
        }
    }
});

// =====================
//Add admins
// =====================
bot.command("add_admin", async (ctx) => {
    if (!isOwner(ctx))
        return ctx.reply("❌ Только владелец может добавлять админов.");


    const args = ctx.message.text.split(" ");
    const newAdminId = Number(args[1]);

    if (!newAdminId) {
        return ctx.reply("⚠️ Использование: /add_admin ID");
    }

    adminsData.addAdmin(newAdminId);

    // Сообщение новому админу
    try {
        await bot.telegram.sendMessage(
            newAdminId,
            "🎉 Вам выдана роль администратора бота."
        );
    } catch (e) {
        console.log("Не удалось отправить сообщение новому админу");
    }

    ctx.reply(`✅ Админ ${newAdminId} добавлен.`);
});

// =====================
//dev
// =====================

bot.command("test", async (ctx) => {
    try {
        const [activeRes, queuesRes, timeRes] = await Promise.all([
            axios.get(process.env.API_ACTIVE),
            axios.get(process.env.API_PARAM),
            axios.get(process.env.API_TIME),
        ])

        const active = activeRes.data;       // [{ queue_id, time_series_id, ... }]
        const queues = queuesRes.data;       // [{ id, name, ... }]
        const slots = timeRes.data;          // [{ id, start, end }]

        if (active.length === 0) {
            return ctx.reply("✅ Зараз відключень немає.");
        }

        // Будуємо мапи для швидкого пошуку
        const queueById = Object.fromEntries(queues.map(q => [q.id, q.name]));
        const slotById  = Object.fromEntries(slots.map(s => [s.id, s]));

        // Групуємо відключення по черзі
        const byQueue = {};
        for (const entry of active) {
            const qName = queueById[entry.queue_id] ?? `id:${entry.queue_id}`;
            const slot  = slotById[entry.time_series_id];
            if (!slot) continue;
            if (!byQueue[qName]) byQueue[qName] = [];
            byQueue[qName].push(`${slot.start.slice(0,5)}–${slot.end.slice(0,5)}`);
        }

        // Зливаємо суміжні слоти в один діапазон
        function mergeSlots(timeRanges) {
            // Сортуємо по початку
            timeRanges.sort();
            const merged = [];
            let [curStart, curEnd] = timeRanges[0].split("–");
            for (let i = 1; i < timeRanges.length; i++) {
                const [s, e] = timeRanges[i].split("–");
                if (s === curEnd || s === "00:00" && curEnd === "00:00") {
                    curEnd = e; // суміжний — розширюємо
                } else {
                    merged.push(`${curStart}–${curEnd}`);
                    [curStart, curEnd] = [s, e];
                }
            }
            merged.push(`${curStart}–${curEnd}`);
            return merged;
        }

        let message = "⚡ *Графік відключень Миколаїв*\n\n";
        for (const [qName, ranges] of Object.entries(byQueue).sort()) {
            const merged = mergeSlots(ranges);
            message += `🔴 *Черга ${qName}:* ${merged.join(", ")}\n`;
        }

        await ctx.reply(message, { parse_mode: "Markdown" });

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Помилка отримання даних");
    }
});




// =====================
// remove admins
// =====================
bot.command("remove_admin", async (ctx) => {
    if (!isOwner(ctx))
        return ctx.reply("❌ Только владелец может удалять админов.");

    const args = ctx.message.text.split(" ");
    const removeId = Number(args[1]);

    if (!removeId) {
        return ctx.reply("⚠️ Использование: /remove_admin ID");
    }

    adminsData.removeAdmin(removeId);

    // Сообщение пользователю
    try {
        await bot.telegram.sendMessage(
            removeId,
            "⚠️ Ваша роль администратора была снята."
        );
    } catch (e) {
        console.log("Не удалось отправить сообщение пользователю");
    }

    ctx.reply(`❌ Админ ${removeId} удалён.`);
});


// =====================
// Admin команды
// =====================
bot.command("send", (ctx) => {

    if(!isOwner(ctx)) return ctx.reply("❌ У вас немає доступу.");
    adminSendState = { awaiting: true };
    ctx.reply(
        "📝 Введіть повідомлення для розсилки всім користувачам.\n" +
        "Надішліть текст/стікер/фото або натисніть /cancel_send щоб скасувати."
    );



});

bot.command("send", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ У вас немає доступу.");
    adminSendState = { awaiting: true };
    ctx.reply(
        "📝 Введіть повідомлення для розсилки всім користувачам.\n" +
        "Надішліть текст/стікер/фото або натисніть /cancel_send щоб скасувати."
    );
});


bot.command("cancel_send", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ У вас немає доступу.");
    if (!adminSendState || !adminSendState.awaiting) return ctx.reply("ℹ️ Нет активной рассылки.");
    adminSendState = null;
    ctx.reply("❌ Розсилка скасована.");



});

bot.command("cancel_send", (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("❌ У вас немає доступу.");
    if (!adminSendState || !adminSendState.awaiting) return ctx.reply("ℹ️ Нет активной рассылки.");
    adminSendState = null;
    ctx.reply("❌ Розсилка скасована.");
});



bot.command("users", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Команда лише для адміністратора.");
    const entries = Object.entries(userMap);
    if (entries.length === 0) return ctx.reply("👥 Немає зареєстрованих користувачів.");

    let parts = [`👥 Всего пользователей: ${entries.length}`];
    for (const [id, info] of entries) {
        if (!info || typeof info === "string") {
            parts.push('________________________________')
            parts.push(`ID: ${id} — ${info || {}}`);
            parts.push('________________________________')
            continue;
        }
        parts.push(
            `ID: ${id} —
             Имя: ${info.firstName || {}},
             Фамилия: ${info.lastName || {}}, 
             Username: ${info.username || {}},
             Телефон: ${info.phone || {}} `
        );
    }

    // Telegram message length limit — split into chunks of ~3000 chars
    const text = parts.join("\n");
    const CHUNK = 3000;
    if (text.length <= CHUNK) return ctx.reply(text);

    for (let i = 0; i < text.length; i += CHUNK) {
        ctx.reply(text.slice(i, i + CHUNK));
    }
});

bot.command("stats", (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("❌ Недоступно.");
    ctx.reply("📊 в разработке ");
});

bot.command("place_admin", (ctx) => {
    if (!isAdmin(ctx)) return;
    const buttons = Object.keys(regions).map(r => [Markup.button.callback(r, `region_${r}`)]);
    ctx.reply("Виберіть область:", Markup.inlineKeyboard(buttons));
});

// =====================
// /place
// =====================
// Вибір області
bot.command("place", (ctx) => {
    const buttons = Object.keys(regions).map(r => [Markup.button.callback(r, `region_${r}`)]);
    ctx.reply("Виберіть область:", Markup.inlineKeyboard(buttons));
});
bot.command("place_admin", (ctx) => {
    const buttons = Object.keys(regions).map(r => [Markup.button.callback(r, `region_${r}`)]);
    ctx.reply("Виберіть область:", Markup.inlineKeyboard(buttons));
});
// Вибір міста
bot.action(/region_(.+)/, (ctx) => {
    const region = ctx.match[1];
    const cities = regions[region] || [];
    const buttons = cities.map(city => [Markup.button.callback(city, `city_${city}`)]);
    ctx.reply(`🏙 Виберіть місто (${region}):`, Markup.inlineKeyboard(buttons));
});

// Вибір групи
bot.action(/city_(.+)/, async (ctx) => {
    const city = ctx.match[1];
    const regionGroups = ["1.1","1.2","2.1","2.2","3.1","3.2","4.1","4.2","5.1","5.2","6.1","6.2"];
    const buttons = regionGroups.map(group => [
        Markup.button.callback(`⚡ Група ${group}`, `g_${group}_${city}`)
    ]);
    await ctx.reply(`📍 Ви вибрали місто: ${city}\n\nОберіть групу:`, Markup.inlineKeyboard(buttons));
});

// Показ графіку для конкретної групи
bot.action(/g_(.+)_(.+)/, async (ctx) => {
    const groupName = ctx.match[1]; // напр. "2.1"
    const city = ctx.match[2];

    await ctx.reply("⏳ Завантажую графік...");

    try {
        const [activeRes, queuesRes, timeRes] = await Promise.all([
            axios.get(process.env.API_ACTIVE),
            axios.get(process.env.API_PARAM),
            axios.get(process.env.API_TIME),
        ]);

        const active = activeRes.data;
        const queues = queuesRes.data;
        const slots  = timeRes.data;

        // Знаходимо id черги по імені (напр. "2.1" → id 16)
        const queue = queues.find(q => q.name === groupName);
        if (!queue) {
            return ctx.reply(`❌ Групу ${groupName} не знайдено в API.`);
        }

        // Фільтруємо активні відключення тільки для цієї черги
        const queueSlots = active.filter(e => e.queue_id === queue.id);

        if (queueSlots.length === 0) {
            return ctx.reply(
                `📍 *${city}* — Група *${groupName}*\n\n✅ Зараз відключень немає.`,
                { parse_mode: "Markdown" }
            );
        }

        const slotById = Object.fromEntries(slots.map(s => [s.id, s]));

        // Збираємо часові діапазони
        const timeRanges = queueSlots
            .map(e => slotById[e.time_series_id])
            .filter(Boolean)
            .map(s => `${s.start.slice(0,5)}–${s.end.slice(0,5)}`);

        // Зливаємо суміжні слоти
        timeRanges.sort();
        const merged = [];
        let [curStart, curEnd] = timeRanges[0].split("–");
        for (let i = 1; i < timeRanges.length; i++) {
            const [s, e] = timeRanges[i].split("–");
            if (s === curEnd) {
                curEnd = e;
            } else {
                merged.push(`${curStart}–${curEnd}`);
                [curStart, curEnd] = [s, e];
            }
        }
        merged.push(`${curStart}–${curEnd}`);

        let message = `📍 *${city}* — Група *${groupName}*\n\n🔴 *Відключення:*\n`;
        merged.forEach(r => { message += `🕒 ${r}\n`; });

        const location = findLocationLink(city);
        await ctx.reply(message, {
            parse_mode: "Markdown",
            ...(location && {
                reply_markup: {
                    inline_keyboard: [[{ text: "🔌 Відкрити сайт", url: location.url }]]
                }
            })
        });

    } catch (error) {
        console.error(error);
        ctx.reply("❌ Помилка отримання даних");
    }
});

// =====================
// /website
// =====================
bot.command("website", async (ctx) => {
    await ctx.reply("🔌 Відкрити графік:", {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Відкрити",
                        web_app: {
                            url: "https://www.energy.mk.ua/vidklyuchennya/"
                        }
                    }
                ]
            ]
        }
    });
});



bot.command("website", async (ctx) => {
    await ctx.reply("🔌 Відкрити графік:", {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Відкрити",
                        web_app: {
                            url: "https://www.energy.mk.ua/vidklyuchennya/"
                        }
                    }
                ]
            ]
        }
    });
});

// =====================
// /dev
// =====================
bot.command("dev", (ctx) => {
    return ctx.reply(devText);
});

bot.command("setdev", (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("❌ У вас нет доступа.");
    devEditState = { awaiting: true };
    ctx.reply("✏️ Надішліть новий текст для команди /dev або /cancel_setdev щоб скасувати.");
});

bot.command("cancel_setdev", (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("❌ У вас нет доступа.");
    if (!devEditState || !devEditState.awaiting) return ctx.reply("ℹ️ Нет активного редактирования.");
    devEditState = null;
    ctx.reply("❌ Редагування скасовано.");
});



// =====================
// Inline кнопки
// =====================
// =====================
// Inline кнопки
// =====================

// Выбор области

// =====================
// /help
// =====================
bot.command("help", async (ctx) => {
    await safeSend(() =>
        ctx.reply(
            "👋 *Помощь*\n\n" +
            "Напишите сообщение — оно уйдёт в поддержку.",
            { parse_mode: "Markdown" }
        )
    );
});

// =====================
// Сообщения
// =====================
bot.on("message", async (ctx) => {
    const msg = ctx.message;
    const from = msg.from || {};
    const userId = from.id;

    if (findLocationLink(msg.text || msg.caption)) return;

    // Якщо адмін надсилає повідомлення — перевіримо режими: редагування /dev або розсилка
    if (ctx.chat.id === ADMIN_ID) {
        const content = msg.text || msg.caption || "[медиа]";

        // Режим редактирования текста для /dev
        if (devEditState && devEditState.awaiting && from.id === ADMIN_ID) {
            if (msg.text || msg.caption) {
                devText = msg.text || msg.caption;
                devEditState = null;
                return ctx.reply("✅ Текст команды /dev успешно обновлён.");
            } else {
                return ctx.reply("⚠️ Неможливо встановити медіа як текст. Надішліть текстове повідомлення.");
            }
        }

        // Режим рассылки
        if (adminSendState && adminSendState.awaiting && from.id === ADMIN_ID) {
            const ids = Object.keys(userMap).map(id => Number(id)).filter(id => id && id !== ADMIN_ID);

            if (ids.length === 0) {
                adminSendState = null;
                return ctx.reply("⚠️ Немає зареєстрованих користувачів для розсилки.");
            }

            let success = 0, failed = 0;
            for (const id of ids) {
                try {
                    if (msg.text) {
                        await bot.telegram.sendMessage(id, content);
                    } else {
                        await bot.telegram.copyMessage(id, ADMIN_ID, msg.message_id);
                    }
                    success++;
                } catch (e) {
                    failed++;
                }
            }

            adminSendState = null;
            return ctx.reply(`✅ Розсилка завершена. Успішно: ${success}. Помилок: ${failed}.`);
        }

        return;
    }

    const firstName = from.first_name || "-";
    const lastName = from.last_name || "-";
    const username = from.username ? `@${from.username}` : "-";
    const phone = (msg.contact && msg.contact.phone_number) ? msg.contact.phone_number : "не указан";
    const content = msg.text || msg.caption || "[медиа]";

    userMap[userId] = {
        firstName,
        lastName,
        username,
        phone,
        lastMessage: content
    };

    const adminMessage =
        `📩 Нове повідомлення до техпідтримки\n` +
        `ID: ${userId}\n` +
        `Имя: ${firstName}\n` +
        `Фамилия: ${lastName}\n` +
        `Username: ${username}\n` +
        `Телефон: ${phone}\n\n` +
        `Сообщение:\n${content}`;

    await safeSend(() =>
        bot.telegram.sendMessage(ADMIN_ID, adminMessage)
    );

    await safeSend(() =>
        ctx.reply("📨 Повідомлення надіслано до підтримки.")
    );
});



// =====================
// Глобальный catch
// =====================
bot.catch((err, ctx) => {
    const code = err?.response?.error_code;
    const update = ctx?.update || {};
    const msg = update.message || update.callback_query?.message || {};
    const from = ctx?.from || msg.from || ctx?.chat || {};
    const userId = from?.id || ctx?.chat?.id || {};

    if (code === 403) {
        const firstName = from.first_name || "-";
        const lastName = from.last_name || "-";
        const username = from.username ? `@${from.username}` : "-";
        const phone = (msg.contact && msg.contact.phone_number) ? msg.contact.phone_number : "не указан";
        const content = msg.text || msg.caption || "[нет сообщения]";

        const adminMessage =
            `🚫 Бот заблоковано користувачем\n` +
            `ID: ${userId}\n` +
            `Имя: ${firstName}\n` +
            `Фамилия: ${lastName}\n` +
            `Username: ${username}\n` +
            `Телефон: ${phone}\n\n` +
            `Последнее сообщение:\n${content}`;

        safeSend(() => bot.telegram.sendMessage(ADMIN_ID, adminMessage));
        console.log(`🚫 Бот заблоковано користувачем ${userId}`);
        return;
    }

    console.error("🔥 Telegraf error:", err);
});

// =====================
// Запуск
// =====================
bot.launch();
console.log("🤖 Бот запущен!");
