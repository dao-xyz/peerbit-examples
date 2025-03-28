export abstract class AbstractStaticContent {

    abstract toString(): string
    abstract get isEmpty(): boolean

    abstract equals(other: AbstractStaticContent): boolean;

    abstract get nativeAddress();

    // it should support an empty constructor
    constructor() { }
}
