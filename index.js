const {
    Client,
    LocalAuth,
    MessageMedia,
    Location,
    Poll
} = require("whatsapp-web.js");

const qrcode = require("qrcode-terminal");
const express = require("express");

const app = express();
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = process.env.API_KEY;
  if (!key || req.get('x-api-key') !== key) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
});
app.use(express.json({ limit: "50mb" }));

/* =========================
   MESSAGE CACHE
   (workaround for the current whatsapp-web.js bug where
   getChatById / fetchMessages throw "r: r" errors)
========================= */

const recentMessages = {}; // { chatId: messageObject } — keyed by whatever WhatsApp sends (c.us or lid)
const recentMediaMessages = {}; // { chatId: mediaMessageObject }
let lastReceivedMessage = null; // fallback: most recent inbound message from anyone, regardless of id format
let lastReceivedMediaMessage = null;

/* =========================
   WHATSAPP CLIENT
========================= */

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: "/app/.wwebjs_auth"
    }),

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

function failure(res, error) {
    console.error(error);

    return res.status(500).json({
        success: false,
        error: error?.message || String(error)
    });
}

/* =========================
   WHATSAPP EVENTS
========================= */

client.on("qr", (qr) => {
    console.log("Scan this QR code with WhatsApp:");
    qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
    console.log("WhatsApp authenticated successfully.");
});

client.on("ready", () => {
    console.log("WhatsApp Web.js is ready!");
});

client.on("auth_failure", (message) => {
    console.error("Authentication failure:", message);
});

client.on("disconnected", (reason) => {
    console.log("WhatsApp disconnected:", reason);
});

/* =========================
   RECEIVE MESSAGES
   Listens on both "message" and "message_create", because some
   WhatsApp Web versions stop firing "message" for incoming chats.
   Each message is handled only once (de-duplicated by id).
========================= */

const seenMessageIds = new Set();

async function handleIncoming(message, source) {
    if (message.fromMe) return;

    const id = message.id?._serialized;
    if (id) {
        if (seenMessageIds.has(id)) return;
        seenMessageIds.add(id);
        if (seenMessageIds.size > 1000) seenMessageIds.clear();
    }

    console.log(
        `[MESSAGE:${source}] ${message.from}: ${message.body || "[media/message]"}`
    );
    console.log(
        `[MESSAGE DETAIL] id=${id} type=${message.type} hasMedia=${message.hasMedia} isStatus=${message.isStatus}`
    );

    // Cache the latest message per chat so /test/reply, /test/react and
    // /test/download-media don't need the currently-broken fetchMessages().
    recentMessages[message.from] = message;
    lastReceivedMessage = message;

    if (message.hasMedia) {
        recentMediaMessages[message.from] = message;
        lastReceivedMediaMessage = message;
    }

    if (message.body === "!ping") {
        try {
            await message.reply("pong");
        } catch (error) {
            console.error("Reply error:", error);
        }
    }
}

client.on("message", (message) => handleIncoming(message, "message"));
client.on("message_create", (message) => handleIncoming(message, "message_create"));

/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
    success(res, {
        status: "running",
        whatsappReady: client.info ? true : false
    });
});

/* =========================
   CLIENT INFO
========================= */

app.get("/test/client-info", async (req, res) => {
    try {
        if (!client.info) {
            return failure(
                res,
                new Error("WhatsApp client is not ready")
            );
        }

        success(res, {
            info: {
                wid: client.info.wid?._serialized,
                pushname: client.info.pushname,
                phone: client.info.wid?.user,
                platform: client.info.platform
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

        await client.sendMessage(chatId, message);

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
            "/app/test.jpg"
        );

        await client.sendMessage(
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
            "/app/resume.docx"
        );

        await client.sendMessage(
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
        let target = recentMessages[chatId];

        if (!target && useLastMessage) {
            target = lastReceivedMessage;
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
        let target = recentMessages[chatId];

        if (!target && useLastMessage) {
            target = lastReceivedMessage;
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
            `[REACT] Attempted react on id=${target.id?._serialized} from=${target.from} type=${target.type}`
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

        await client.sendMessage(
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

        await client.sendMessage(
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

        const contact = await client.getContactById(
            chatIdFromPhone(contactPhone)
        );

        await client.sendMessage(
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
                await client.getContactById(
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
                await client.getChatById(
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
            await client.getChatById(
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
            await client.getChatById(
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
            await client.getContactById(
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
            await client.getContactById(
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
            await client.getChats();

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
                await client.getChatById(
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
                await client.getChatById(
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
                await client.acceptInvite(
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
                await client.createGroup(
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
                await client.getChatById(
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
                await client.getChatById(
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
                await client.getChatById(
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
                await client.getChatById(
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
                await client.getChatById(
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
                await client.getChatById(
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

            await client.sendMessage(
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
                await client.getChatById(
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

            await client.setStatus(
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
                await client.getContactById(
                    chatIdFromPhone(
                        contactPhone
                    )
                );

            const chatId =
                chatIdFromPhone(phone);

            await client.sendMessage(
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
            let mediaMessage = recentMediaMessages[chatId];

            if (!mediaMessage && useLastMessage) {
                mediaMessage = lastReceivedMediaMessage;
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

app.listen(
    3000,
    "0.0.0.0",
    () => {
        console.log(
            "WhatsApp API running on port 3000"
        );
    }
);

/* =========================
   START WHATSAPP
========================= */

client.initialize();