class StateMachineRunTimeError {
    constructor(message) {
        this.message = message;
        this.name = 'State.TaskFailed';
    }
}

module.exports = StateMachineRunTimeError;
