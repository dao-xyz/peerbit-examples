import { View } from "./content";
import { field, variant, fixedArray, vec, option } from "@dao-xyz/borsh";
import {
    Documents,
    SearchRequest,
    StringMatch,
    StringMatchMethod,
} from "@peerbit/document";
import { PublicSignKey, randomBytes } from "@peerbit/crypto";
import { Program } from "@peerbit/program";
import { sha256Sync } from "@peerbit/crypto";
import { concat } from "uint8arrays";


@variant("chat")
export class ChatView extends View {
}
