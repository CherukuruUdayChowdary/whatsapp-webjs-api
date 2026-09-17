/* =========================================================
   WhatsApp Web.js API — multi-account version
   - Several WhatsApp numbers in one container
   - Pick the number per request with the "x-account" header,
     "?account=" query or "account" field in the JSON body
     (defaults to "default", the number that was already linked)
========================================================= */

const fs = require("fs");
const path = require("path");
const {
    Client,
    LocalAuth,
    MessageMedia,
    Location,
    Poll
} = require("whatsapp-web.js");

const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const express = require("express");

const AUTH_PATH = process.env.AUTH_PATH || "/app/.wwebjs_auth";
const ACCOUNTS_FILE = path.join(AUTH_PATH, "accounts.json");
const DEFAULT_ACCOUNT = "default";
const ACCOUNT_ID_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS || 5);

const app = express();

app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const key = process.env.API_KEY;
    if (!key || req.get("x-api-key") !== key) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
});
app.use(express.json({ limit: "50mb" }));

/* =========================
   HELPER FUNCTIONS
========================= */

function cleanPhone(phone) {
    return String(phone).replace(/\D/g, "");
}

function chatIdFromPhone(phone) {
    return `${cleanPhone(phone)}@c.us`;
}

function success(res, data = {}) {
    return res.json({
        success: true,
        ...data
    });
}

function failure(res, error, status = 500) {
    if (status >= 500) console.error(error);

    return res.status(status).json({
        success: false,
        error: error?.message || String(error)
    });
}

/* =========================
   ACCOUNTS
========================= */

const accounts = new Map(); // id -> account object

function loadAccountIds() {
    try {
        const ids = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
        if (Array.isArray(ids)) {
            return ids.filter((id) => ACCOUNT_ID_RE.test(id));
        }
    } catch (error) {
        // first run: no file yet
    }
    return [];
}

function saveAccountIds() {
    fs.mkdirSync(AUTH_PATH, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([...accounts.keys()]));
}

function sessionDir(id) {
    // LocalAuth stores the default (no clientId) session in "session",
    // and every other account in "session-<clientId>"
    return path.join(
        AUTH_PATH,
        id === DEFAULT_ACCOUNT ? "session" : `session-${id}`
    );
}

function publicAccount(acc) {
    return {
        id: acc.id,
        state: acc.state,
        phone: acc.client?.info?.wid?.user || null,
        pushname: acc.client?.info?.pushname || null,
        lastError: acc.lastError || null
    };
}

function buildClient(id) {
    const authStrategy =
        id === DEFAULT_ACCOUNT
            ? new LocalAuth({ dataPath: AUTH_PATH }) // keeps the existing session
            : new LocalAuth({ dataPath: AUTH_PATH, clientId: id });

    return new Client({
        authStrategy,
        puppeteer: {
            executablePath: "/usr/bin/chromium",
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-zygote",
                "--disable-extensions",
                "--headless=new",
                "--disable-software-rasterizer",
                "--disable-background-networking",
                "--disable-features=Translate,BackForwardCache"
            ]
        }
    });
}

/* =========================
   RECEIVE MESSAGES (per account)
   Listens on both "message" and "message_create", because some
   WhatsApp Web versions stop firing "message" for incoming chats.
   Each message is handled only once (de-duplicated by id).
========================= */

// WhatsApp system notices that should never count as "last received message"
const SYSTEM_MESSAGE_TYPES = new Set([
    "e2e_notification",
    "notification_template",
    "notification",
    "gp2",
    "protocol",
    "call_log",
    "ciphertext",
    "revoked"
]);

async function handleIncoming(acc, message, source) {
    if (message.fromMe) return;
    if (message.isStatus) return;
    if (SYSTEM_MESSAGE_TYPES.has(message.type)) return;

    const id = message.id?._serialized;
    if (id) {
        if (acc.seen.has(id)) return;
        acc.seen.add(id);
        if (acc.seen.size > 1000) acc.seen.clear();
    }

    console.log(
        `[${acc.id}] [MESSAGE:${source}] ${message.from}: ${message.body || "[media/message]"}`
    );
    console.log(
        `[${acc.id}] [MESSAGE DETAIL] id=${id} type=${message.type} hasMedia=${message.hasMedia} isStatus=${message.isStatus}`
    );

    // Cache the latest message per chat so /test/reply, /test/react and
    // /test/download-media don't need the currently-broken fetchMessages().
    acc.recentMessages[message.from] = message;
    acc.lastReceivedMessage = message;

    if (message.hasMedia) {
        acc.recentMediaMessages[message.from] = message;
        acc.lastReceivedMediaMessage = message;
    }

    if (message.body === "!ping") {
        try {
            await message.reply("pong");
        } catch (error) {
            console.error(`[${acc.id}] Reply error:`, error);
        }
    }
}

function startAccount(id, delayMs = 0) {
    const acc = {
        id,
        state: "initializing",
        qr: null,
        qrImage: null,
        lastError: null,
        recentMessages: {},
        recentMediaMessages: {},
        lastReceivedMessage: null,
        lastReceivedMediaMessage: null,
        seen: new Set(),
        stopping: false
    };

    const client = buildClient(id);
    const tag = `[${id}]`;
    acc.client = client;
    accounts.set(id, acc);

    client.on("qr", async (qr) => {
        acc.state = "qr";
        acc.qr = qr;
        try {
            acc.qrImage = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
        } catch (error) {
            acc.qrImage = null;
        }
        console.log(`${tag} Scan this QR code (also available at GET /accounts/${id}/qr):`);
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on("authenticated", () => {
        acc.state = "authenticated";
        acc.qr = null;
        acc.qrImage = null;
        console.log(`${tag} WhatsApp authenticated successfully.`);
    });

    client.on("ready", () => {
        acc.state = "ready";
        acc.lastError = null;
        console.log(`${tag} WhatsApp Web.js is ready! (${client.info?.wid?.user || "unknown number"})`);
    });

    client.on("auth_failure", (message) => {
        acc.state = "auth_failure";
        acc.lastError = String(message);
        console.error(`${tag} Authentication failure:`, message);
    });

    client.on("disconnected", (reason) => {
        console.log(`${tag} WhatsApp disconnected:`, reason);
        acc.state = "disconnected";
        acc.lastError = String(reason);
        if (acc.stopping) return;

        // Start again so a new QR code (or the saved session) is used
        setTimeout(() => {
            if (accounts.get(id) === acc && !acc.stopping) {
                restartAccount(id).catch((error) =>
                    console.error(`${tag} restart failed:`, error)
                );
            }
        }, 5000);
    });

    client.on("message", (message) => handleIncoming(acc, message, "message"));
    client.on("message_create", (message) => handleIncoming(acc, message, "message_create"));

    setTimeout(() => {
        client.initialize().catch((error) => {
            acc.state = "error";
            acc.lastError = error?.message || String(error);
            console.error(`${tag} initialize failed:`, error);
        });
    }, delayMs);

    return acc;
}

async function stopAccount(id) {
    const acc = accounts.get(id);
    if (!acc) return;

    acc.stopping = true;
    accounts.delete(id);

    try {
        await acc.client.destroy();
    } catch (error) {
        console.error(`[${id}] destroy error:`, error?.message || error);
    }
}

async function restartAccount(id) {
    await stopAccount(id);
    return startAccount(id);
}

function getAccountOr404(req, res) {
    const id = String(req.params.id || "").toLowerCase();
    const acc = accounts.get(id);
    if (!acc) {
        failure(res, new Error(`Unknown account "${id}"`), 404);
        return null;
    }
    return acc;
}

/* =========================
   ACCOUNT MANAGEMENT
========================= */

app.get("/accounts", (req, res) => {
    success(res, {
        accounts: [...accounts.values()].map(publicAccount)
    });
});

app.post("/accounts", (req, res) => {
    try {
        const id = String(req.body?.id || "").trim().toLowerCase();

        if (!ACCOUNT_ID_RE.test(id)) {
            return failure(
                res,
                new Error("id must be 1-32 characters: lowercase letters, numbers, - or _"),
                400
            );
        }
        if (accounts.has(id)) {
            return failure(res, new Error(`Account "${id}" already exists`), 409);
        }
        if (accounts.size >= MAX_ACCOUNTS) {
            return failure(res, new Error(`Maximum of ${MAX_ACCOUNTS} accounts reached`), 400);
        }

        const acc = startAccount(id);
        saveAccountIds();

        success(res, {
            account: publicAccount(acc),
            message: `Account created. Open GET /accounts/${id}/qr and scan the QR code with the new phone.`
        });
    } catch (error) {
        failure(res, error);
    }
});

app.get("/accounts/:id", (req, res) => {
    const acc = getAccountOr404(req, res);
    if (!acc) return;
    success(res, { account: publicAccount(acc) });
});

app.get("/accounts/:id/qr", (req, res) => {
    const acc = getAccountOr404(req, res);
    if (!acc) return;
    success(res, {
        id: acc.id,
        state: acc.state,
        qr: acc.qr,
        qrImage: acc.qrImage // data:image/png;base64,... (null unless state is "qr")
    });
});

app.post("/accounts/:id/restart", async (req, res) => {
    try {
        const acc = getAccountOr404(req, res);
        if (!acc) return;
        const fresh = await restartAccount(acc.id);
        success(res, { account: publicAccount(fresh), message: "Account restarting" });
    } catch (error) {
        failure(res, error);
    }
});

app.post("/accounts/:id/logout", async (req, res) => {
    try {
        const acc = getAccountOr404(req, res);
        if (!acc) return;

        acc.stopping = true; // don't auto-restart from the "disconnected" event
        try {
            await acc.client.logout(); // unlinks the device and deletes the session
        } catch (error) {
            console.error(`[${acc.id}] logout error:`, error?.message || error);
        }

        const fresh = await restartAccount(acc.id);
        success(res, {
            account: publicAccount(fresh),
            message: "Logged out. A new QR code will be available shortly."
        });
    } catch (error) {
        failure(res, error);
    }
});

app.delete("/accounts/:id", async (req, res) => {
    try {
        const acc = getAccountOr404(req, res);
        if (!acc) return;

        if (acc.id === DEFAULT_ACCOUNT) {
            return failure(res, new Error("The default account can't be deleted (use logout instead)"), 400);
        }

        await stopAccount(acc.id);
        saveAccountIds();

        const removeSession = req.query.removeSession === "true";
        if (removeSession) {
            fs.rmSync(sessionDir(acc.id), { recursive: true, force: true });
        }

        success(res, {
            id: acc.id,
            removedSession: removeSession,
            message: "Account deleted"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
    const def = accounts.get(DEFAULT_ACCOUNT);
    success(res, {
        status: "running",
        whatsappReady: def?.state === "ready",
        accounts: [...accounts.values()].map((acc) => ({
            id: acc.id,
            state: acc.state
        }))
    });
});

/* =========================
   ACCOUNT SELECTION
   Every route below runs against req.wa (the chosen account)
========================= */

app.use((req, res, next) => {
    const id = String(
        req.get("x-account") ||
        req.query?.account ||
        req.body?.account ||
        DEFAULT_ACCOUNT
    ).toLowerCase();

    const acc = accounts.get(id);
    if (!acc) {
        return failure(res, new Error(`Unknown account "${id}"`), 404);
    }
    if (acc.state !== "ready") {
        return failure(
            res,
            new Error(`Account "${id}" is not ready (state: ${acc.state})`),
            503
        );
    }

    req.wa = acc;
    next();
});

/* =========================
   CLIENT INFO
========================= */

app.get("/test/client-info", async (req, res) => {
    try {
        const info = req.wa.client.info;

        success(res, {
            account: req.wa.id,
            info: {
                wid: info?.wid?._serialized,
                pushname: info?.pushname,
                phone: info?.wid?.user,
                platform: info?.platform
            }
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   SEND TEXT
========================= */

app.post("/send", async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return failure(
                res,
                new Error("phone and message are required")
            );
        }

        const chatId = chatIdFromPhone(phone);

        await req.wa.client.sendMessage(chatId, message);

        success(res, {
            to: chatId,
            message: "Message sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   SEND IMAGE
========================= */

app.post("/send-image", async (req, res) => {
    try {
        const { phone, caption } = req.body;

        if (!phone) {
            return failure(
                res,
                new Error("phone is required")
            );
        }

        const chatId = chatIdFromPhone(phone);

        const media = MessageMedia.fromFilePath(
            "/app/sample.jpg"
        );

        await req.wa.client.sendMessage(
            chatId,
            media,
            {
                caption: caption || ""
            }
        );

        success(res, {
            to: chatId,
            message: "Image sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   SEND DOCUMENT
========================= */

app.post("/send-document", async (req, res) => {
    try {
        const { phone, caption } = req.body;

        if (!phone) {
            return failure(
                res,
                new Error("phone is required")
            );
        }

        const chatId = chatIdFromPhone(phone);

        const media = MessageMedia.fromFilePath(
            "/app/sample.docx"
        );

        await req.wa.client.sendMessage(
            chatId,
            media,
            {
                caption: caption || ""
            }
        );

        success(res, {
            to: chatId,
            message: "Document sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   MESSAGE REPLY
   (uses cached message instead of fetchMessages)
========================= */

app.post("/test/reply", async (req, res) => {
    try {
        const { phone, message, useLastMessage } = req.body;

        if (!phone || !message) {
            return failure(
                res,
                new Error("phone and message are required")
            );
        }

        const chatId = chatIdFromPhone(phone);
        let target = req.wa.recentMessages[chatId];

        if (!target && useLastMessage) {
            target = req.wa.lastReceivedMessage;
        }

        if (!target) {
            return failure(
                res,
                new Error(
                    "No cached message found for this exact phone/id — WhatsApp may have delivered it under a different id (e.g. @lid instead of @c.us). Pass \"useLastMessage\": true to reply to the most recent inbound message from anyone instead."
                )
            );
        }

        await target.reply(message);

        success(res, {
            repliedTo: target.id?._serialized || null,
            message: "Reply sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   REACT
   (uses cached message instead of fetchMessages)
========================= */

app.post("/test/react", async (req, res) => {
    try {
        const { phone, emoji, useLastMessage } = req.body;

        if (!phone || !emoji) {
            return failure(
                res,
                new Error(
                    "phone and emoji are required"
                )
            );
        }

        const chatId = chatIdFromPhone(phone);
        let target = req.wa.recentMessages[chatId];

        if (!target && useLastMessage) {
            target = req.wa.lastReceivedMessage;
        }

        if (!target) {
            return failure(
                res,
                new Error(
                    "No cached message found for this exact phone/id — WhatsApp may have delivered it under a different id (e.g. @lid instead of @c.us). Pass \"useLastMessage\": true to react to the most recent inbound message from anyone instead."
                )
            );
        }

        await target.react(emoji);

        console.log(
            `[${req.wa.id}] [REACT] Attempted react on id=${target.id?._serialized} from=${target.from} type=${target.type}`
        );

        success(res, {
            messageId: target.id?._serialized || null,
            emoji,
            message: "Reaction sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   SEND LOCATION
========================= */

app.post("/test/send-location", async (req, res) => {
    try {
        const {
            phone,
            latitude,
            longitude,
            description
        } = req.body;

        if (
            !phone ||
            latitude === undefined ||
            longitude === undefined
        ) {
            return failure(
                res,
                new Error(
                    "phone, latitude and longitude are required"
                )
            );
        }

        const location = new Location(
            Number(latitude),
            Number(longitude),
            {
                name: description || "Location"
            }
        );

        const chatId = chatIdFromPhone(phone);

        await req.wa.client.sendMessage(
            chatId,
            location
        );

        success(res, {
            to: chatId,
            message: "Location sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   POLL
========================= */

app.post("/test/poll", async (req, res) => {
    try {
        const {
            phone,
            question,
            options
        } = req.body;

        if (
            !phone ||
            !question ||
            !Array.isArray(options)
        ) {
            return failure(
                res,
                new Error(
                    "phone, question and options are required"
                )
            );
        }

        const poll = new Poll(
            question,
            options
        );

        const chatId = chatIdFromPhone(phone);

        await req.wa.client.sendMessage(
            chatId,
            poll
        );

        success(res, {
            to: chatId,
            message: "Poll sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   CONTACT CARD
========================= */

app.post("/test/contact", async (req, res) => {
    try {
        const {
            phone,
            contactPhone
        } = req.body;

        if (!phone || !contactPhone) {
            return failure(
                res,
                new Error(
                    "phone and contactPhone are required"
                )
            );
        }

        const contact = await req.wa.client.getContactById(
            chatIdFromPhone(contactPhone)
        );

        await req.wa.client.sendMessage(
            chatIdFromPhone(phone),
            contact
        );

        success(res, {
            to: chatIdFromPhone(phone),
            contact: chatIdFromPhone(contactPhone),
            message: "Contact card sent successfully"
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   PROFILE PICTURE
========================= */

app.get(
    "/test/profile-picture/:phone",
    async (req, res) => {
        try {
            const contact =
                await req.wa.client.getContactById(
                    chatIdFromPhone(
                        req.params.phone
                    )
                );

            const url =
                await contact.getProfilePicUrl();

            success(res, {
                phone: req.params.phone,
                profilePicture: url || null
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   CHAT INFO
========================= */

app.get(
    "/test/chat/:phone",
    async (req, res) => {
        try {
            const chat =
                await req.wa.client.getChatById(
                    chatIdFromPhone(
                        req.params.phone
                    )
                );

            success(res, {
                chat: {
                    id: chat.id?._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    unreadCount: chat.unreadCount,
                    archived: chat.archived,
                    pinned: chat.pinned,
                    isMuted: chat.isMuted
                }
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   MUTE CHAT
========================= */

app.post("/test/mute", async (req, res) => {
    try {
        const {
            phone,
            duration
        } = req.body;

        if (!phone) {
            return failure(
                res,
                new Error("phone is required")
            );
        }

        const chat =
            await req.wa.client.getChatById(
                chatIdFromPhone(phone)
            );

        const unmuteDate = duration
            ? new Date(Date.now() + Number(duration) * 1000)
            : undefined;

        await chat.mute(unmuteDate);

        success(res, {
            phone,
            muted: true
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   UNMUTE CHAT
========================= */

app.post("/test/unmute", async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return failure(
                res,
                new Error("phone is required")
            );
        }

        const chat =
            await req.wa.client.getChatById(
                chatIdFromPhone(phone)
            );

        await chat.unmute();

        success(res, {
            phone,
            muted: false
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   BLOCK CONTACT
========================= */

app.post("/test/block", async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return failure(
                res,
                new Error("phone is required")
            );
        }

        const contact =
            await req.wa.client.getContactById(
                chatIdFromPhone(phone)
            );

        await contact.block();

        success(res, {
            phone,
            blocked: true
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   UNBLOCK CONTACT
========================= */

app.post("/test/unblock", async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone) {
            return failure(
                res,
                new Error("phone is required")
            );
        }

        const contact =
            await req.wa.client.getContactById(
                chatIdFromPhone(phone)
            );

        await contact.unblock();

        success(res, {
            phone,
            blocked: false
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   GROUP LIST
========================= */

app.get("/test/groups", async (req, res) => {
    try {
        const chats =
            await req.wa.client.getChats();

        const groups = chats
            .filter((chat) => chat.isGroup)
            .map((group) => ({
                id: group.id?._serialized,
                name: group.name,
                participants:
                    group.participants?.length || 0
            }));

        success(res, {
            groups
        });
    } catch (error) {
        failure(res, error);
    }
});

/* =========================
   GROUP INFO
========================= */

app.get(
    "/test/group-info/:groupId",
    async (req, res) => {
        try {
            const group =
                await req.wa.client.getChatById(
                    req.params.groupId
                );

            if (!group.isGroup) {
                return failure(
                    res,
                    new Error(
                        "The supplied chat is not a group"
                    )
                );
            }

            success(res, {
                group: {
                    id: group.id?._serialized,
                    name: group.name,
                    description:
                        group.description,
                    participants:
                        group.participants?.map(
                            (p) => ({
                                id: p.id?._serialized,
                                isAdmin: p.isAdmin,
                                isSuperAdmin:
                                    p.isSuperAdmin
                            })
                        )
                }
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP INVITE
========================= */

app.get(
    "/test/group-invite/:groupId",
    async (req, res) => {
        try {
            const group =
                await req.wa.client.getChatById(
                    req.params.groupId
                );

            if (!group.isGroup) {
                return failure(
                    res,
                    new Error(
                        "The supplied chat is not a group"
                    )
                );
            }

            const invite =
                await group.getInviteCode();

            success(res, {
                inviteCode: invite,
                inviteLink:
                    `https://chat.whatsapp.com/${invite}`
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   JOIN GROUP
========================= */

app.post(
    "/test/join-group",
    async (req, res) => {
        try {
            const { inviteCode } =
                req.body;

            if (!inviteCode) {
                return failure(
                    res,
                    new Error(
                        "inviteCode is required"
                    )
                );
            }

            const result =
                await req.wa.client.acceptInvite(
                    inviteCode
                );

            success(res, {
                result,
                message:
                    "Group joined successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   CREATE GROUP
========================= */

app.post(
    "/test/create-group",
    async (req, res) => {
        try {
            const {
                name,
                participants
            } = req.body;

            if (
                !name ||
                !Array.isArray(
                    participants
                )
            ) {
                return failure(
                    res,
                    new Error(
                        "name and participants are required"
                    )
                );
            }

            const ids =
                participants.map(
                    chatIdFromPhone
                );

            const group =
                await req.wa.client.createGroup(
                    name,
                    ids
                );

            success(res, {
                group,
                message:
                    "Group created successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP SUBJECT
========================= */

app.post(
    "/test/group-subject",
    async (req, res) => {
        try {
            const {
                groupId,
                subject
            } = req.body;

            if (!groupId || !subject) {
                return failure(
                    res,
                    new Error(
                        "groupId and subject are required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            await group.setSubject(
                subject
            );

            success(res, {
                groupId,
                subject,
                message:
                    "Group subject updated successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP DESCRIPTION
========================= */

app.post(
    "/test/group-description",
    async (req, res) => {
        try {
            const {
                groupId,
                description
            } = req.body;

            if (!groupId) {
                return failure(
                    res,
                    new Error(
                        "groupId is required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            await group.setDescription(
                description || ""
            );

            success(res, {
                groupId,
                description:
                    description || "",
                message:
                    "Group description updated successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP ADD
========================= */

app.post(
    "/test/group-add",
    async (req, res) => {
        try {
            const {
                groupId,
                participants
            } = req.body;

            if (
                !groupId ||
                !Array.isArray(
                    participants
                )
            ) {
                return failure(
                    res,
                    new Error(
                        "groupId and participants are required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            const result =
                await group.addParticipants(
                    participants.map(
                        chatIdFromPhone
                    )
                );

            success(res, {
                result,
                message:
                    "Participants added successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP REMOVE
========================= */

app.post(
    "/test/group-remove",
    async (req, res) => {
        try {
            const {
                groupId,
                participants
            } = req.body;

            if (
                !groupId ||
                !Array.isArray(
                    participants
                )
            ) {
                return failure(
                    res,
                    new Error(
                        "groupId and participants are required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            const result =
                await group.removeParticipants(
                    participants.map(
                        chatIdFromPhone
                    )
                );

            success(res, {
                result,
                message:
                    "Participants removed successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP PROMOTE
========================= */

app.post(
    "/test/group-promote",
    async (req, res) => {
        try {
            const {
                groupId,
                participants
            } = req.body;

            if (
                !groupId ||
                !Array.isArray(
                    participants
                )
            ) {
                return failure(
                    res,
                    new Error(
                        "groupId and participants are required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            const result =
                await group.promoteParticipants(
                    participants.map(
                        chatIdFromPhone
                    )
                );

            success(res, {
                result,
                message:
                    "Participants promoted successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP DEMOTE
========================= */

app.post(
    "/test/group-demote",
    async (req, res) => {
        try {
            const {
                groupId,
                participants
            } = req.body;

            if (
                !groupId ||
                !Array.isArray(
                    participants
                )
            ) {
                return failure(
                    res,
                    new Error(
                        "groupId and participants are required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            const result =
                await group.demoteParticipants(
                    participants.map(
                        chatIdFromPhone
                    )
                );

            success(res, {
                result,
                message:
                    "Participants demoted successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP SEND MESSAGES
========================= */

app.post(
    "/test/group-send-messages",
    async (req, res) => {
        try {
            const {
                groupId,
                message
            } = req.body;

            if (!groupId || !message) {
                return failure(
                    res,
                    new Error(
                        "groupId and message are required"
                    )
                );
            }

            await req.wa.client.sendMessage(
                groupId,
                message
            );

            success(res, {
                groupId,
                message:
                    "Group message sent successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   GROUP EDIT INFO
========================= */

app.post(
    "/test/group-edit-info",
    async (req, res) => {
        try {
            const {
                groupId,
                sendMessages,
                editInfo
            } = req.body;

            if (!groupId) {
                return failure(
                    res,
                    new Error(
                        "groupId is required"
                    )
                );
            }

            const group =
                await req.wa.client.getChatById(
                    groupId
                );

            const results = {};

            if (
                sendMessages !==
                undefined
            ) {
                results.sendMessages =
                    await group
                        .setMessagesAdminsOnly(
                            Boolean(
                                sendMessages
                            )
                        );
            }

            if (
                editInfo !==
                undefined
            ) {
                results.editInfo =
                    await group
                        .setInfoAdminsOnly(
                            Boolean(
                                editInfo
                            )
                        );
            }

            success(res, {
                groupId,
                results
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   STATUS MESSAGE
========================= */

app.post(
    "/test/status",
    async (req, res) => {
        try {
            const { status } =
                req.body;

            if (status === undefined) {
                return failure(
                    res,
                    new Error(
                        "status is required"
                    )
                );
            }

            await req.wa.client.setStatus(
                status
            );

            success(res, {
                status,
                message:
                    "Status updated successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   CONTACT CARD
========================= */

app.post(
    "/test/contact-card",
    async (req, res) => {
        try {
            const {
                phone,
                contactPhone
            } = req.body;

            if (
                !phone ||
                !contactPhone
            ) {
                return failure(
                    res,
                    new Error(
                        "phone and contactPhone are required"
                    )
                );
            }

            const contact =
                await req.wa.client.getContactById(
                    chatIdFromPhone(
                        contactPhone
                    )
                );

            const chatId =
                chatIdFromPhone(phone);

            await req.wa.client.sendMessage(
                chatId,
                contact
            );

            success(res, {
                to: chatId,
                contact:
                    chatIdFromPhone(
                        contactPhone
                    ),
                message:
                    "Contact card sent successfully"
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   DOWNLOAD RECEIVED MEDIA
   (uses cached media message instead of fetchMessages)
========================= */

app.post(
    "/test/download-media",
    async (req, res) => {
        try {
            const { phone, useLastMessage } =
                req.body;

            if (!phone) {
                return failure(
                    res,
                    new Error(
                        "phone is required"
                    )
                );
            }

            const chatId = chatIdFromPhone(phone);
            let mediaMessage = req.wa.recentMediaMessages[chatId];

            if (!mediaMessage && useLastMessage) {
                mediaMessage = req.wa.lastReceivedMediaMessage;
            }

            if (!mediaMessage) {
                return failure(
                    res,
                    new Error(
                        "No cached media message found for this exact phone/id — WhatsApp may have delivered it under a different id (e.g. @lid). Pass \"useLastMessage\": true to use the most recent inbound media from anyone instead."
                    )
                );
            }

            const media =
                await mediaMessage.downloadMedia();

            if (!media) {
                return failure(
                    res,
                    new Error(
                        "Unable to download media"
                    )
                );
            }

            success(res, {
                messageId:
                    mediaMessage.id
                        ?._serialized ||
                    null,
                mimetype:
                    media.mimetype,
                filename:
                    media.filename ||
                    null,
                dataLength:
                    media.data?.length ||
                    0
            });
        } catch (error) {
            failure(res, error);
        }
    }
);

/* =========================
   EXPRESS SERVER
========================= */

app.listen(3000, "0.0.0.0", () => {
    console.log("WhatsApp API running on port 3000");
});

/* =========================
   START ACCOUNTS
   The default account always exists; others are restored from
   accounts.json. Start-ups are staggered to spread the load.
========================= */

const savedIds = loadAccountIds();
if (!savedIds.includes(DEFAULT_ACCOUNT)) savedIds.unshift(DEFAULT_ACCOUNT);
savedIds.forEach((id, index) => startAccount(id, index * 5000));