export abstract class AbstractStaticContent {

    abstract toString(): string
    abstract get isEmpty(): boolean

    // it should support an empty constructor
    constructor() { }
}
