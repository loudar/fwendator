// Get the current user's Discord token from Discord's webpack runtime
async function getToken() {
    console.log("⚙️ Initializing...");
    try {
        // Borrow webpack's module registry in the page context
        let wpRequire;
        window.webpackChunkdiscord_app?.push([
            [Symbol()],
            {},
            req => (wpRequire = req)
        ]);

        if (!wpRequire || !wpRequire.c) {
            // Fallback: ask user for token if webpack isn't available
            const manual = window.prompt(
                "Could not automatically access Discord internals. Please paste your Discord token:",
                ""
            );
            if (manual && manual.trim()) return manual.trim();
            throw new Error("Webpack runtime not available. Are you running this on discord.com?");
        }

        const modules = Object.values(wpRequire.c);
        const tokenModule = modules.find(mod => {
            try {
                return mod?.exports?.default?.getToken !== undefined;
            } catch (_) {
                return false;
            }
        });

        const token = tokenModule?.exports?.default?.getToken?.();
        if (!token) {
            // Per requirement: if we would have shown the failure, instead prompt for the token
            const manual = window.prompt(
                "Could not automatically find your token. Please paste your Discord token:",
                ""
            );
            if (manual && manual.trim()) return manual.trim();
            throw new Error("Token not provided.");
        }
        return token;
    } catch (err) {
        console.error("Failed to get token:", err);
        // Final fallback: prompt once more if not already prompted
        const manual = window.prompt(
            "Failed to get token automatically. Please paste your Discord token:",
            ""
        );
        if (manual && manual.trim()) return manual.trim();
        throw err;
    }
}

// Fetch JSON helper with Authorization header
async function fetchJson(url, token) {
    const res = await fetch(url, {
        headers: {
            Authorization: token
        }
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}: ${text}`);
    }
    return res.json();
}

// Get all user friends (relationships) and return the embedded user objects
async function getFriends(token) {
    console.log("✉️ Fetching friends...");
    const relationships = await fetchJson("https://discord.com/api/v9/users/@me/relationships", token);
    return Object.values(relationships).map(r => r.user);
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

// Iterate over every friend and create the final JSON data
async function buildFriendGraph(friends, token) {
    const estimateMinutes = Math.floor(friends.length / 60);
    const estimateSeconds = friends.length % 60;
    console.log(
        `⏱ This will take about ${
            estimateMinutes > 0
                ? estimateMinutes + (estimateMinutes === 1 ? " minute and " : " minutes and ")
                : ""
        }${estimateSeconds > 0 ? estimateSeconds + (estimateSeconds === 1 ? " second" : " seconds") : ""}`
    );

    const out = {};
    let index = 0;
    for (const friend of friends) {
        index += 1;
        const uid = friend.id;
        const avh = friend.avatar;
        const avatarUrl = avh ? `https://cdn.discordapp.com/avatars/${uid}/${avh}.webp?size=128` : "";

        const rel = await fetchJson(`https://discord.com/api/v9/users/${uid}/relationships`, token);
        out[uid] = {
            name: `${friend.username}#${friend.discriminator}`,
            avatarUrl,
            mutual: Object.values(rel).map(e => e.id)
        };

        console.log(`📃 Parsing friends... [${index}/${friends.length}]`);
        await sleep(1000); // be gentle to the API
    }

    let selfId = `friends-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19).replaceAll("-", "")}`;
    try {
        // Add the origin/self user so the source has a clear hub connected to all friends
        console.log("👤 Fetching self user…");
        const me = await f("https://discord.com/api/v9/users/@me", t);
        if (me && me.id) {
            selfId = me.id;
        }
    } catch (e) {
        console.warn("⚠️ Could not fetch self user; continuing without explicit origin node.", e);
    }

    return {
        data: out,
        id: selfId
    };
}

// Clear page and show result
function renderResult(data, id) {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.body.appendChild(Object.assign(document.createElement("h1"), {
        innerHTML: "Your friends data ✨"
    }));
    document.body.appendChild(Object.assign(document.createElement("textarea"), {
        value: JSON.stringify(data, null, 2),
        readOnly: true,
        style: `width: 100%; height: 400px;`
    }));
    document.body.appendChild(Object.assign(document.createElement("button"), {
        innerHTML: "📄 Download data",
        onclick: function () {
            const url = URL.createObjectURL(new Blob([JSON.stringify(data)], {
                type: "application/json"
            }));
            Object.assign(document.createElement("a"), {
                href: url,
                download: `${id}.json`
            }).click();
            URL.revokeObjectURL(url)
        }
    }))
}

// Main function
async function main() {
    try {
        const isDiscord = window.location.hostname.endsWith("discord.com");
        if (!isDiscord) {
            alert("Not on discord.com — open this in Discord's web app page.");
            return;
        }

        const token = await getToken();
        const friends = await getFriends(token);
        const {data, id} = await buildFriendGraph(friends, token);
        renderResult(data, id);
        console.log("✨ Done");
    } catch (err) {
        console.error(err);
        alert(`Failed: ${err?.message || err}`);
    }
}

main();