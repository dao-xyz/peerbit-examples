export function TW(...strings: (string | undefined)[]): TWClass {
    return new TWClass(strings);
}

export function tw(...strings: (string | undefined)[]): string {
    return TW(...strings).toString();
}

class TWClass {
    private classes: string[];

    constructor(classes: (string | undefined)[]) {
        this.classes = classes.filter(
            (cls): cls is string => cls !== undefined
        );
    }

    toString(): string {
        return this.classes.join(" ");
    }
}

// Make TypeScript happy with the dual function/constructor pattern
export interface TW {
    (...strings: (string | undefined)[]): TWClass;
    new (...strings: (string | undefined)[]): TWClass;
}
