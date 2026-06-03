<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import { createClient, ExampleStore, SimpleDocument } from "./db";

const loading = ref(true);
const error = ref<string | undefined>();
const message = ref("");
const messages = ref<string[]>([]);
const peerId = ref<string>("");

let store: ExampleStore | undefined;
let cleanup: (() => void) | undefined;

onMounted(async () => {
    try {
        const client = await createClient();
        peerId.value = client.libp2p.peerId.toString();
        store = await client.open(new ExampleStore());

        const onChange = (evt: Event) => {
            const changeEvent = evt as CustomEvent<{ added: SimpleDocument[] }>;
            for (const doc of changeEvent.detail.added) {
                messages.value = [...messages.value, doc.content];
            }
        };

        store.documents.events.addEventListener("change", onChange);
        cleanup = () => store?.documents.events.removeEventListener("change", onChange);

        await store.documents.put(
            new SimpleDocument({
                content: `Hello from ${peerId.value}`,
            }),
        );
    } catch (err) {
        error.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
});

onBeforeUnmount(() => {
    cleanup?.();
});

const sendMessage = async () => {
    const content = message.value.trim();

    if (!content || !store) {
        return;
    }

    await store.documents.put(new SimpleDocument({ content }));
    message.value = "";
};
</script>

<template>
    <main>
        <p class="eyebrow">Peerbit + Vue 3</p>
        <h1>Peerbit Vue Example</h1>
        <p class="intro">
            Open this app in multiple tabs to see document updates replicated with Peerbit.
        </p>

        <section class="panel">
            <p v-if="loading">Connecting to Peerbit…</p>
            <p v-else-if="error" class="error">{{ error }}</p>
            <template v-else>
                <p class="peer">Peer ID: {{ peerId }}</p>
                <form @submit.prevent="sendMessage">
                    <input
                        v-model="message"
                        type="text"
                        placeholder="Write a message"
                        aria-label="Message"
                    />
                    <button type="submit">Share</button>
                </form>

                <ul>
                    <li v-for="item in messages" :key="item">{{ item }}</li>
                </ul>
            </template>
        </section>
    </main>
</template>
