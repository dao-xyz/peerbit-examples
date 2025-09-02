import { ProgramClient } from "@peerbit/program";
import path, { dirname } from "path";
import fs from "fs";
import { Profiles, ensureProfile } from "@giga-app/interface";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ensures this node has a profile:
 * - Picks a random avatar from /resources (AIIcon1.jpg..AIIcon13.jpg)
 * - Calls ensureProfile(client, imageBytes) which:
 *   * opens the deterministic public profile scope
 *   * creates/opens the profile Canvas in that scope
 *   * writes the avatar (all qualities)
 *   * stores the Profile record pointing to that Canvas
 * - Returns the stored Profile record
 */
export const createProfile = async (client: ProgramClient) => {
    // Quick check: if a profile already exists, just return it
    const profiles = await client.open(new Profiles(), { existing: "reuse" });
    const existing = await profiles.get(client.identity.publicKey);
    if (existing) return existing;

    // Pick a random local avatar image
    const pickName = () => `AIIcon${Math.floor(Math.random() * 13 + 1)}.jpg`;
    let iconPath = path.join(__dirname, "resources", pickName());
    if (!fs.existsSync(iconPath)) {
        iconPath = path.join(__dirname, "..", "resources", pickName());
    }
    if (!fs.existsSync(iconPath)) {
        throw new Error("No avatar image found in resources/");
    }

    const imageBytes = new Uint8Array(fs.readFileSync(iconPath));

    // This handles scope creation, canvas creation, avatar writes, and Profile storage
    const { canvas, profile } = await ensureProfile(client, imageBytes);
    console.log(
        "Created profile for",
        client.identity.publicKey.toString(),
        "with canvas",
        canvas.idString
    );
    return profile;
};
