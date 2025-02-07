import { Peerbit } from "peerbit";
import { Alias, BlogPosts, Post } from "..";
import { waitForResolved, delay } from "@peerbit/time";
describe("bootstrap", () => {
    let peer: Peerbit;
    let peer2: Peerbit;

    after(async () => {
        // @ts-ignore
        await peer?.stop();
        // @ts-ignore
        await peer2?.stop();
    });

    it("should bootstrap the application", async () => {
        /* const postMap = {
            "Odo": [
                {
                    "title": "The Importance of Order",
                    "content": "Security is not just a job; it's a calling. The key to a peaceful station is order. Without it, chaos reigns, and chaos is the antithesis of civilization. Every citizen, every visitor, every molecule aboard this station has its place, and it is my duty to ensure they remain there. The rules are clear, the regulations strict, but fair. They are the framework within which a society flourishes. To those who find my methods rigid, I say: order is the bedrock of our survival."
                },
                {
                    "title": "The Loneliness of Command",
                    "content": "Command comes with a weight, a solitude that those who have never held it may never understand. My position requires a detachment from personal relationships, a sacrifice for the greater good of the station. It's a role I've accepted, but not without its costs. My duty is to protect, even at the expense of personal connections. Perhaps, in another life, I could have been different. But in this one, I stand watch, ever vigilant, ever alone."
                },
                {
                    "title": "Reflections on Justice",
                    "content": "Justice is not a concept, but a living, breathing necessity. It's not about punishment, but balance. True justice sees beyond the individual to the harmony of the whole. In my time, I've seen it bent, twisted, and ignored, but I've also seen it prevail. As I walk these corridors, I am ever mindful of its delicate presence, guarding it fiercely against those who would seek to undermine it. For without justice, we are nothing but savages in the dark."
                }
            ],
            "Garak": [{
                "title": "The Subtlety of Fabric",
                "content": "In the world of espionage, much like in tailoring, the devil is in the details. A well-tailored suit can say much about a person—perhaps even more than they'd like. It's the subtle nuances that make all the difference, whether you're stitching a seam or unraveling a mystery. And just like in intelligence work, in fashion, one must always be prepared to read between the lines—or the threads, as it were. Remember, a stitch in time not only saves nine; it might just save your life."
            },
            {
                "title": "Garak's Guide to Interstellar Diplomacy",
                "content": "Diplomacy, like a good suit, requires a keen eye and a deft touch. It's not merely about what is said; it's about what is implied. In my many... let's call them 'encounters'... across the Alpha Quadrant, I've learned that sometimes the most powerful statement is made in silence. Or, in my case, with a perfectly timed smile. After all, when words fail, there's always fashion. And if you can't trust a tailor to patch things up, who can you trust?"
            },
            {
                "title": "The Art of the Unseen",
                "content": "There's an art to being unnoticed. You might think it odd for a tailor to say so, but there's nothing more rewarding than the art of blending in. Whether it's the cut of your jacket or the secrets you wish to keep, the true skill lies in being present without being seen. Just remember, if you ever find yourself the center of attention, it might be time to change your outfit—or your tactics. After all, in both fashion and life, sometimes the best strategy is to keep them guessing."
            }
            ],
            "Gul Dukat": [
                {
                    "title": "The Burden of Leadership",
                    "content": "True leadership is not about popularity; it's about making the difficult decisions that others are too weak to face. During my time on Bajor, I was often misunderstood. My efforts to bring order, progress, and stability were seen as oppression. But history is written by the victors, and they seldom paint their adversaries in a flattering light. A leader must be willing to bear the burden of being vilified in the present to be exonerated by future generations. Remember, it's the results that define us, not the accusations of those who oppose us."
                },
                {
                    "title": "The Misunderstood Peacekeeper",
                    "content": "They call me a tyrant, a conqueror, but they fail to see the peace I brought in the midst of chaos. Bajor was on the brink of self-destruction before the Cardassians intervened. We brought structure, discipline, and, yes, peace to a world that desperately needed it. The path to harmony often requires a firm hand, and I was more than willing to be that hand. Critics will focus on the methods, ignoring the outcomes. But ask yourself, would Bajor have survived without Cardassian intervention? The answer is uncomfortable for those who refuse to look beyond their narrow perspective."
                },
                {
                    "title": "Power and Perception",
                    "content": "Power is not just about strength or the ability to control others; it's about shaping perception. My actions have always been in the interest of greater stability and prosperity, not just for Cardassia, but for all those touched by our influence. Unfortunately, in the pursuit of peace, one must often be prepared to be seen as the villain. It's a role I've accepted, knowing that the true measure of my contributions will only be understood with the passage of time. The greatest leaders are those who dare to do what is necessary, regardless of how they will be judged in the moment."
                }
            ],
            "Quark": [{
                "title": "The Art of the Deal",
                "content": "Business is like a game of Dabo, full of risks and opportunities. The key is knowing when to spin the wheel. But it's not just about profit; it's about the thrill, the negotiation, the chase. There's an art to striking a deal that satisfies all parties—especially if that satisfaction leans heavily in your favor. Remember, a true Ferengi doesn't just seek profit; they embody it, in every transaction, every interaction. Rule of Acquisition #62: The riskier the road, the greater the profit."
            },
            {
                "title": "Family and Fortune",
                "content": "They say you can't choose your family but you can choose how to make profit from them. My dear brother Rom and my nephew Nog, as different as they are, remind me that even in a universe driven by profit, family has its value. It's a complicated balance, managing familial bonds while pursuing the accumulation of wealth. But, as any good Ferengi knows, family, too, can be an asset. Just remember, Rule of Acquisition #6: Never allow family to stand in the way of opportunity."
            },
            {
                "title": "Hospitality: The Quark Way",
                "content": "Running the best bar on Deep Space Nine isn't just about serving drinks. It's about creating an experience, a sanctuary where all species can indulge in the finest pleasures the galaxy has to offer. Whether it's a Klingon seeking a strong drink or a Bajoran in need of a quiet moment, Quark's is the place. Sure, profit is my north star, but customer satisfaction is what keeps them coming back. After all, a satisfied customer is a spending customer. Rule of Acquisition #9: Opportunity plus instinct equals profit."
            }
            ],
            "Benjamin Sisko": [
                {
                    "title": "The Burden of Command",
                    "content": "Commanding Deep Space Nine is more than a duty; it's a privilege and a challenge. The decisions I make affect not just the crew, but entire civilizations. The weight of these decisions can't be taken lightly. It's about balancing the needs of the many with the rights of the individual, and sometimes, making the hard choices for the greater good. But through it all, I'm reminded that leadership isn't just about giving orders; it's about inspiring those around you to be their best selves."
                },
                {
                    "title": "Exploring the Final Frontier",
                    "content": "Exploration is at the heart of what we do in Starfleet. It's not just about charting stars or discovering new worlds, but about understanding the diverse cultures that make up the fabric of the universe. Each encounter, each new discovery adds to our collective knowledge and brings us closer to understanding our place in the cosmos. The unknown may be daunting, but it's also where we find our greatest growth."
                },
                {
                    "title": "The Journey of the Emissary",
                    "content": "My role as the Emissary to the Prophets was unexpected, but it's a journey I've come to embrace. It's taught me the importance of faith, not just in the divine, but in ourselves and in each other. The path has been anything but straightforward, filled with trials and revelations that have challenged my beliefs and my identity. But through it, I've learned that our destinies are not written in stone; they're forged by the choices we make and the paths we choose to follow."
                }
            ],
            "Jadzia Dax": [
                {
                    "title": "The Lives Within Me",
                    "content": "Being a joined Trill means carrying the memories and experiences of all the Dax symbiont's previous hosts. It's an honor and a responsibility. Each host's life is a chapter in a long, ongoing story that I'm privileged to continue. From Curzon's wisdom to Torias's bravery, each has shaped who I am today. Their lives, their loves, and even their mistakes, are lessons that guide me. It's a unique perspective that I bring to my crew and friends, one that I hope enriches our shared journey."
                },
                {
                    "title": "The Science of Discovery",
                    "content": "Science is more than experiments and equations; it's a way of looking at the universe with curiosity and wonder. Each discovery, no matter how small, has the potential to change our understanding of the cosmos. My role aboard Deep Space Nine allows me to explore the mysteries of the galaxy, from the wormhole to new life forms. It's a reminder that the universe is vast, and there's always more to learn, more to explore."
                },
                {
                    "title": "Friendship Across Stars",
                    "content": "The bonds we form, the friendships we cherish, are what truly make Deep Space Nine special. It's a place where diverse beings from across the galaxy come together, not just to work, but to form connections that transcend species and worlds. From my friendship with Benjamin to the camaraderie of the entire crew, these relationships are a testament to the power of unity and understanding. They remind us that, in the grand scheme of the universe, we are not so different after all."
                }
            ],
            "Kira Nerys": [
                {
                    "title": "The Fight for Bajor",
                    "content": "My life has been defined by the struggle for Bajor's freedom. The occupation taught us the cost of oppression, but also the value of resilience. As we rebuild, we carry the lessons of our past, the pain and the hope, into our future. It's a future we must shape with care, ensuring that freedom and justice are its foundation. My role on Deep Space Nine is not just as a liaison but as a guardian of that future, a reminder of what we've fought to achieve."
                },
                {
                    "title": "Faith and the Prophets",
                    "content": "Faith has always been a cornerstone of Bajoran culture, a source of strength through our darkest times. The Prophets, our guides and protectors, have always been a part of our lives, even more so now with the discovery of the wormhole. My own faith has been tested, challenged, and ultimately strengthened through my experiences on Deep Space Nine. It's a personal journey, one that has taught me the importance of belief, not just in the divine, but in the potential within each of us."
                },
                {
                    "title": "Hospitality: The Quark Way",
                    "content": "Running the best bar on Deep Space Nine isn't just about serving drinks. It's about creating an experience, a sanctuary where all species can indulge in the finest pleasures the galaxy has to offer. Whether it's a Klingon seeking a strong drink or a Bajoran in need of a quiet moment, Quark's is the place. Sure, profit is my north star, but customer satisfaction is what keeps them coming back. After all, a satisfied customer is a spending customer. Rule of Acquisition #9: Opportunity plus instinct equals profit."
                }
            ],
            "Grand Nagus": [
                {
                    "title": "Profit: The Ultimate Pursuit",
                    "content": "In the grand tapestry of the cosmos, there is one universal language: profit. It drives civilizations, fosters innovations, and, most importantly, it's the foundation of Ferengi society. As the Grand Nagus, I've seen firsthand how the pursuit of profit shapes destinies. It's not merely about amassing wealth but about the thrill of the chase, the strategies, and the satisfaction of a well-negotiated deal. Remember, Rule of Acquisition #1: Once you have their money, you never give it back. Embrace the pursuit, for in profit, we find our greatest achievements."
                },
                {
                    "title": "The Art of Negotiation",
                    "content": "Negotiation is an art form, a delicate dance between desire and discretion. A true Ferengi knows that every interaction is a potential deal waiting to be struck. It's about reading your opponent, understanding their needs, and, most importantly, knowing when to strike. But remember, the best deals leave both parties feeling like they've won—though, of course, you should win a little more. Rule of Acquisition #33: It never hurts to suck up to the boss. Whether you're dealing with customers or the Grand Nagus himself, negotiation is the key to unlocking untold riches."
                },
                {
                    "title": "Leadership and Profit",
                    "content": "Leadership in the Ferengi Alliance isn't just about guiding our people; it's about steering them towards greater profits. A leader's vision must encompass not only the present wealth but the potential for future earnings. It's about innovation, taking calculated risks, and always being three steps ahead of your competitors. But let's not forget, Rule of Acquisition #109: Dignity and an empty sack is worth the sack. A true leader knows that profit is the ultimate measure of success. Lead with your lobes, and let the latinum follow."
                }
            ],
            "Piccard": [
                {
                    "title": "The Joy of Earl Grey",
                    "content": "There's a profound simplicity in the ritual of tea preparation. Each morning, as I command the replicator to produce a steaming cup of Earl Grey, hot, I'm reminded of the comfort found in routine. The familiar aroma, the warmth of the cup against my hands, it's a moment of peace before the day's adventures begin. It's in these small rituals that we find anchors in our lives, a steady presence amidst the chaos of the universe. So, here's to finding your own 'Earl Grey'—whatever that may be—and allowing it to bring a moment of tranquility into your day."
                },
                {
                    "title": "The Art of the Shakespearean Insult",
                    "content": "Shakespeare, a constant companion of mine, was a master of the artful insult. His characters wield words with the precision of a phaser, and I must confess, I find a certain guilty pleasure in their creativity. 'Thou cream faced loon', 'beetle-headed, flap-ear'd knave'—the Bard knew how to turn a phrase. While I advocate for diplomacy first and foremost, there's an undeniable charm in imagining a negotiation with a Klingon using nothing but Shakespearean barbs. Of course, in practice, I'd recommend keeping such thoughts as amusing diversions rather than diplomatic strategies."
                },
                {
                    "title": "On the Merits of a Quiet Evening",
                    "content": "In the vast expanse of space, with stars speeding by at warp speed, there's an unparalleled beauty in a quiet evening spent aboard the Enterprise. Sometimes, it's a solitary walk through the arboretum, or an hour spent with a good book (a physical one, mind you) in my quarters. There's a strength to be found in stillness, a reminder that amidst our quests to explore new worlds, we must also make time to explore the inner spaces of our thoughts and emotions. So, here's to the quiet moments, the pauses between adventures, where we're reminded of who we are and what truly matters."
                },
                {
                    "title": "An Unplanned Concert: Notes Through the Corridors",
                    "content": "There's something about music that can bridge the gap between people, even in the vastness of space. This was never clearer to me than one evening aboard the Enterprise, when Lieutenant Commander Nella Daren and I found a mutual passion in our love for music. We decided to play a piece together, combining the sounds of her piano with my flute. The acoustics of a Jeffries tube on Deck 9 offered us a secluded spot, perfect for our impromptu duet. Little did we know, our private performance wouldn't remain private for long. As Brahms' notes flowed from our instruments, they somehow made their way to Engineering, turning our duo into a ship-wide serenade. It was unintended, but the reactions were unexpectedly heartwarming. Crew members later told us how the music had given them a brief respite, a moment of unexpected peace amid their routines. It was a small, unplanned gift to our fellow travelers, a reminder of the community we share on this journey through the stars. That evening, music did more than fill a room; it filled the space between us, reminding everyone on board that beauty and art have a place even here, among the cold expanse of space."
                }
            ]
        }

        for (const [author, posts] of Object.entries(postMap)) {


            console.log("Author", author)
            await peer?.stop()
            peer = await Peerbit.create();
            await peer.bootstrap() //  await peer.dial(remoteAddress)

            const platform = await peer.open(new BlogPosts());

            await waitForResolved(() => expect(platform.posts.log.getReplicatorsSorted().length).to.be.greaterThan(1))
            await platform.alias.put(new Alias({ name: author, publicKey: peer.identity.publicKey }));
            for (const post of posts) {
                await platform.posts.put(new Post({ title: post.title, content: post.content }));
            }

            await delay(1000)

        }
        await peer?.stop()
        peer = await Peerbit.create();
        const platform = await peer.open(new BlogPosts(), { args: { role: 'observer' } });
        await peer.bootstrap() //  await peer.dial(remoteAddress)

        await waitForResolved(() => expect(platform.posts.log.getReplicatorsSorted().length).to.be.greaterThan(0))
        const posts = await platform.getLatestPosts(1000);
        console.log(posts.length) */
    });
});
