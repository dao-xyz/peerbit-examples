export function TW(...strings: string[]): TWClass {
    return new TWClass(strings);
}

export function tw(...strings: string[]): string {
    return TW(...strings).toString();
}

class TWClass {
    private classes: string[];

    constructor(classes: string[]) {
        this.classes = classes;
    }

    toString(): string {
        return this.classes.join(" ");
    }
}

// Make TypeScript happy with the dual function/constructor pattern
export interface TW {
    (...strings: string[]): TWClass;
    new (...strings: string[]): TWClass;
}
