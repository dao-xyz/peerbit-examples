import { ProgramClient } from "@peerbit/program";
import path, { dirname } from "path";
import fs from "fs";
import {
    Canvas,
    Element,
    Layout,
    StaticContent,
    StaticImage,
} from "@giga-app/interface";
import { Profile, Profiles } from "@giga-app/interface";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));

export const createProfile = async (client: ProgramClient) => {
    const profiles = await client.open(new Profiles());
    const profile = await profiles.get(client.identity.publicKey);
    if (!profile) {
        // create a profile!
        const canvas = await client.open(
            new Canvas({
                parent: undefined,
                publicKey: client.identity.publicKey,
            })
        );

        // in the project folder we have AIIcon1.jpg to AIIcon13.jpg
        // randomly select one
        let iconFileName =
            "AIIcon" + Math.floor(Math.random() * 13 + 1) + ".jpg";
        let icon = path.join(__dirname, "resources", iconFileName);
        if (!fs.existsSync(icon)) {
            // look one folder up
            icon = path.join(__dirname, "..", "resources", iconFileName);
        }
        const image = fs.readFileSync(icon);
        await canvas.elements.put(
            new Element({
                location: Layout.zero(),
                content: new StaticContent({
                    content: new StaticImage({
                        data: image,
                        mimeType: "image/jpeg",
                        width: 100,
                        height: 100,
                    }),
                }),
                parent: canvas,
                publicKey: client.identity.publicKey,
            })
        );

        await profiles.profiles.put(
            new Profile({
                publicKey: client.identity.publicKey,
                profile: canvas,
            })
        );
    }
};
