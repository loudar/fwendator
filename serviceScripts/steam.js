async function getSite(url) {
    const res = await fetch(url, {
        credentials: "include",
    });
    if (res.status === 429) {
        console.log(`Rate limit exceeded, waiting 60s...`);
        await new Promise(resolve => setTimeout(resolve, 60 * 1000));
        await getSite(url);
    }

    return await res.text();
}

async function getFriends() {
    const elements = document.querySelectorAll(".friend_block_v2");
    const friends = [];

    const estSeconds = 5 * elements.length;
    console.log(`Estimated time: ${estSeconds} seconds`);

    for (let i = 0; i < elements.length; i++) {
        console.log(`Processing friend ${i + 1} of ${elements.length}`);
        const element = elements[i];
        const id = element.attributes['data-steamid'].nodeValue;
        const miniProfileId = element.attributes['data-miniprofile'].nodeValue;
        const avatarUrl = element.querySelector("img").src;
        const profileUrl = element.querySelector("a").href;
        const name = element.querySelector(".friend_block_content").textContent
            .split("\n").at(0)
            .replace(/\*$/g, "");

        const commonList = document.createElement("div");
        commonList.innerHTML = await getSite(`https://steamcommunity.com/actions/PlayerList/?type=friendsincommon&target=${miniProfileId}`);
        const mutualsNodes = commonList.querySelectorAll(".friendBlock");

        const friend = {
            id,
            name,
            profileUrl,
            avatarUrl,
            mutual: [],
            source: "steam"
        };

        if (mutualsNodes.length > 0) {
            for (const mutual of mutualsNodes) {
                const link = mutual.querySelector("a").href;
                friend.mutual.push(link);
            }
        }

        friends.push(friend);
        console.log(`Waiting 5s...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const out = {};
    for (const friend of friends) {
        const ids = [];
        for (const secondaryId of friend.mutual) {
            const mutual = friends.find(m => m.profileUrl === secondaryId);
            if (mutual) {
                ids.push(mutual.id);
            } else {
                console.warn(`Could not find mutual ${secondaryId}`);
            }
        }
        friend.mutual = ids;
        out[friend.id] = friend;
    }

    return out;
}

const obj = await getFriends();
console.log(obj);

const downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(obj)], {
    type: "application/json"
}));
Object.assign(document.createElement("a"), {
    href: downloadUrl,
    download: `steam_friends.json`
}).click();
setTimeout(() => {
    URL.revokeObjectURL(downloadUrl);
}, 2000);
