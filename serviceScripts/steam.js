async function getFriends() {
    const elements = document.querySelectorAll(".friend_block_v2");
    const friends = [];

    const estSeconds = 5 * elements.length;
    console.log(`Estimated time: ${estSeconds} seconds`);

    for (let i = 0; i < elements.length; i++) {
        console.log(`Processing friend ${i + 1} of ${elements.length}`);
        const element = elements[i];
        const id = element.attributes['data-steamid'].nodeValue;
        const avatarUrl = element.querySelector("img").src;
        const profileLink = element.querySelector("a").href;
        const name = element.querySelector(".friend_block_content").textContent
            .split("\n").at(0)
            .replace(/\*$/g, "");

        const res = await fetch(profileLink, {
            credentials: "include",
        });
        if (res.status === 429) {
            console.log(`Rate limit exceeded, waiting 60s...`);
            await new Promise(resolve => setTimeout(resolve, 60 * 1000));
            continue;
        }

        const data = await res.text();
        const newNode = document.createElement("div");
        newNode.innerHTML = data;
        const mutualsNodes = newNode.querySelector(".profile_topfriends")?.children ?? [];

        const friend = {
            id,
            profileLink,
            name,
            avatarUrl,
            mutual: [],
            source: "steam"
        };

        for (const mutual of mutualsNodes) {
            const link = mutual.querySelector("a").href;
            friend.mutual.push(link);
        }

        friends.push(friend);
        console.log(`Waiting 5s...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    console.log(friends);
    const out = {};
    for (const friend of friends) {
        const ids = [];
        for (const secondaryId of friend.mutual) {
            const mutual = friends.find(m => m.profileLink === secondaryId);
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

const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], {
    type: "application/json"
}));
Object.assign(document.createElement("a"), {
    href: url,
    download: `steam_friends.json`
}).click();
URL.revokeObjectURL(url)