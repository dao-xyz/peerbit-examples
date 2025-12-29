import type { ProgramClient } from "@peerbit/program";
import { Canvas, ReplyKind, type Scope } from "@giga-app/interface";

export async function publishMarkdownReply(options: {
    node: ProgramClient;
    scope: Scope;
    parent: Canvas;
    markdown: string;
    visibility?: "both" | "child";
}): Promise<Canvas> {
    const draft = new Canvas({ publicKey: options.node.identity.publicKey });

    const [, post] = await options.scope.getOrCreateReply(
        options.parent,
        draft,
        {
            kind: new ReplyKind(),
            visibility: options.visibility ?? "both",
        }
    );

    await post.addTextElement(options.markdown);

    try {
        await post.nearestScope._hierarchicalReindex?.flush(post.idString);
    } catch {}
    try {
        await options.parent.nearestScope._hierarchicalReindex?.flush(
            options.parent.idString
        );
    } catch {}

    return post;
}
