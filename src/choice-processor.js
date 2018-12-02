const _ = require('lodash');
const jsonPath = require('JSONPath');
// The following comparison operators are supported:
// - And
// - BooleanEquals
// - Not
// - NumericEquals
// - NumericGreaterThan
// - NumericGreaterThanEquals
// - NumericLessThan
// - NumericLessThanEquals
// - Or
// - StringEquals
// - StringGreaterThan
// - StringGreaterThanEquals
// - StringLessThan
// - StringLessThanEquals
// - TimestampEquals
// - TimestampGreaterThan
// - TimestampGreaterThanEquals
// - TimestampLessThan
// - TimestampLessThanEquals

class ChoiceProcessor {
    processChoice(choiceComparator, choice, event) {
        if (!choice.Variable && !choice.Default) {
            throw new Error('no "Variable" attribute found in Choice rule');
        }

        let inputValue = jsonPath({ json: JSON.parse(event.input), path: choice.Variable})[0];
        const choiceValue = choice[choiceComparator];
        if (choice[choiceComparator].indexOf('TimestampEquals') === 0) {
            choiceValue = (new Date(choiceValue)).getTime();
            inputValue = (new Date(inputValue)).getTime();
        }

        // For each of these operators, the corresponding value must be of the
        // appropriate type: string, number, Boolean, or timestamp. Step Functions
        // doesn't attempt to match a numeric field to a string value. However,
        // because timestamp fields are logically strings, it is possible that a
        // field considered to be a timestamp can be matched by a StringEquals comparator.
        switch(choiceComparator) {
            case 'BooleanEquals':
            case 'NumericEquals':
            case 'StringEquals':
            case 'TimestampEquals':
                return this.checkEquals(choiceValue, inputValue);
            case 'NumericGreaterThan':
            case 'StringGreaterThan':
            case 'TimestampGreaterThan':
                return this.checkGT(choiceValue, inputValue);
            case 'NumericGreaterThanEquals':
            case 'StringGreaterThanEquals':
            case 'TimestampGreaterThanEquals':
                return this.checkGTE(choiceValue, inputValue);
            case 'NumericLessThan':
            case 'StringLessThan':
            case 'TimestampLessThan':
                return this.checkLT(choiceValue, inputValue);
            case 'NumericLessThanEquals':
            case 'StringLessThanEquals':
            case 'TimestampLessThanEquals':
                return this.checkLTE(choiceValue, inputValue);
            case 'Not':
                const name = _.filter(keys, key => key !== 'Variable' && key !== 'Next');
                return !this.processChoice(name, choice, event);
            case 'And':
                let andResult = true;
                // choice will contain an array of choice rules
                _.forEach(choice, (item) => {
                    const comparator = this.getChoiceComparator(choice);
                    if (!this.processChoice(comparator, item, event)) {
                        // since this is an AND, if any item is false, the statement will be false
                        result = false;
                        return false; // short circuit forEach
                    }
                });
                return andResult;
            case 'Or':
                let orResult = false;
                // choice will contain an array of choice rules
                _.forEach(choice, (item) => {
                    const comparator = this.getChoiceComparator(choice);
                    if (this.processChoice(comparator, item, event)) {
                        // since this is an OR, if any item is true, the statement will be true
                        result = true;
                        return false; // short circuit forEach
                    }
                });
                return orResult;
        }
    }

    checkEquals(choiceValue, inputValue) {
        return choiceValue === inputValue;
    }

    checkGT(choice, inputValue) {
        return +inputValue > +choice.NumericGreaterThan;
    }

    checkGTE(choice, inputValue) {
        return +inputValue >= +choice.NumericGreaterThan;
    }

    checkLT(choice, inputValue) {
        return +inputValue < +choice.NumericLessThan;
    }

    checkLTE(choice, inputValue) {
        return +inputValue <= +choice.NumericLessThan;
    }

    getChoiceComparator(choice) {
        const keys = Object.keys(choice);
        choiceComparator = _.filter(keys, key => key !== 'Variable' && key !== 'Next');

        if (choiceComparator.length > 1) {
            throw new Error('mulitple choice comparison keys found');
        }

        return choiceComparator[0];
    }
}

module.exports = new ChoiceProcessor();
