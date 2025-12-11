/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

'use strict';

const chai = require('chai');
const { decrypt } = require('../lib/encrypt');

const expect = chai.expect;
chai.config.includeStack = true;

describe('Test legacy crypto.createDecipher compatability', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    it('legacy crypto.createDecipher compatability expect success / aes192', async () => {
        // Old crypto.createDecipher encrypted data as hex string
        const secret = 'secretpassword';
        const somecleartextEnc = '7e8eeeed5273809e2bcb8c41166f9036'; // "somecleartext"
        const emptyStringEnc = 'd9719a66830f56f8de41126a5106871e'; // ""
        const loremIpsumEnc =
            'f13d3608ef292f3a85d28156532cef58eb5626a0c7ca6f600181c7e76cf94fdb4cbf2b68ff18d7dfc12f7348414678e8d28305eaf4f7a3d1a796cb72d858ca9a2e17a5e295bb4263d01d71a0dec701cb20c6838163424431db8cb4b47727999fd4049b44c9e73269d08bd9de85edfdd2f2d69bf084348189f4cc00f495ba4abb36a4a0347efd981a5dfdfaa6dc8da71501736376e0eba4e3815551ee8bdb7bde8e948f37a6a993fe36c188276a3684184b6fd915ef820d2ba05703c6f2292b232c7182f58271411245763238878fef81904b94df88d46179b42f68b4bc43d8076e9a24c81171d1b1fa8adf720ca93fdcfe8e95501808a084bb5c7edaef1b3ad1e33e1a599c5dd2f714bf3a8a87277b99089a5a4c000597d6d7fc1a33f9b786f2cee0a2b0949fa8d7284dd9be6cbd028901edf3b91a5450a0f895fe429b82493c4a3ba9cefab94f30b3a94093d7176478364db2d968cfa2b412ba9f7d056f841feb1dc6329fe73e35bc1d66b7eded6880bf0ea3543163fd18b267bd40c900d0b301a1eb1ef9f3045a536830567df45dab01425739a5747a5ee628a086bada43ee3d33c951dba63f8fe562e65f1548b0367a28425a4040c9877a5b22cdbfc0cb702adfd94f0315eb24c4e43262bc1d8c510051d327073d2423a217f6fa0cc8c0b38660e3a21ba863036f23c6ddfa7afe3b23856cadb21649869c31bdafc0f3bf7615a7a6e817c8fd5380da8adb9adf68a2d062bbe2835b05d769c16aa78c22018e296ff9019b1571627d166052219d197d069fbeac1cdd1573cab86081c2b66228aacfae8ec2b782b7eabb157afe02fa2706227beea3cf485d6486feddd1f3f815137f52180775ca1d6a5501aaeccf3eca9eb4d2676db160792faeb8b1157c875048bbf74e620eb1da4ac26c1bce4974a6f642e3136cff8662b9287d1c4e6716f9f3716ff72a02d96e1efb879656e68b10e496ab1bf3a7f8b116ee4d2e2c84b206a493662cfa22bb1862a42ad60684b12d23413194e571f0e2d898f45b75e8e228';

        const somecleartextDec = 'somecleartext';
        const emptyStringDec = '';
        const loremIpsumDec =
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Aenean a mi tempus, faucibus metus at, sollicitudin enim. Donec varius metus non luctus malesuada. Integer risus metus, laoreet quis faucibus quis, faucibus non tortor. Nulla ac magna id eros lobortis cursus in non risus. Suspendisse at faucibus risus, nec tempor neque. Quisque sed ante tempus, cursus velit venenatis, blandit lacus. Mauris maximus quis elit vitae fermentum. Maecenas tempor tristique arcu vel facilisis. Sed libero dui, mollis quis felis ut, molestie gravida tellus. Nunc a lorem vitae arcu interdum ullamcorper. Quisque convallis diam ut quam maximus sollicitudin. Praesent a dui dolor. Maecenas laoreet sapien a consequat semper. Cras eget nisl enim. ';

        const someCleartextEncDec = await decrypt('$' + somecleartextEnc, secret, 'aes192');
        expect(someCleartextEncDec).to.eq(somecleartextDec);

        const emptyStringEncDec = await decrypt('$' + emptyStringEnc, secret, 'aes192');
        expect(emptyStringEncDec).to.eq(emptyStringDec);

        const loremIpsumEncDec = await decrypt('$' + loremIpsumEnc, secret, 'aes192');
        expect(loremIpsumEncDec).to.eq(loremIpsumDec);
    });

    it('legacy crypto.createDecipher compatability expect success / aes256', async () => {
        // Old crypto.createDecipher encrypted data as hex string
        const secret = 'secretpassword';
        const somecleartextEnc = 'c2fc7efc04416b495e8fa6f64b0bf390'; // "somecleartext"
        const emptyStringEnc = 'ee58c5f9fff6eda35edc4b135a05a5fb'; // ""
        const loremIpsumEnc =
            '2a3a3d1626f50516e5e435f4363144cfac7a1dba41ff3d1c306009d5160334f31619d55051ffe567754f675634d9ace12177b25bf74f3b1bcf219cc0a00f58fca0332b3ff2fdffdc5eaf29541f254b747c8af0e5e00aaffac2f72848818e0e160d58abffc476e11ed09ce6e84729317e2713d6290da088e888af239a2b523d16b972cde0104ac0ea75d1b3d16759c03af9653c4aab191517aa2ff64fd1b6679be60f7da7ed99f23d5273d85a09980c3230b52781155628cd58966edf4ab9108c8e05206c400779aae19692bdbbab01469d0699147276c31e34d9ed4c622eb1f5ea67d6748607ff0b8b288600cde7c9868623caf537821ae46ca94d8fefcc4d9b1912542ab0dc34064de73d66d4fd0ce93927182ddca0dc0cba45e18ca5b1b442f39f2225875792ae8f1b006437a32a23c01b49a6c9d76a80b42730f4d874def092b9b985a3f4a868623e3f8d9ec3c8f6b2cbdafc8749260dde13f4fc9daef3f9d65aa153bce96f79d052c65b55b7cd4798ae32bc7f850d281ecc91874fad3e3835ef1a9ad038f8c1d265d934a8d089d521670a55990637bf87d371c722c5261073923d7e21d8d5a94cec107503c336a620d95bff6d04101dce598aaf8b9932993459adfa17d993f09f66b144be28c55f1632d78c72538e98c964324552792ffb58d4279f06b3a1560ac6732b742badc1a4b9fded53c9d21b3de9d702d3032c09c216656286d702ba2fd7fbc718eac608ebcf64107004f0ac90ffd36b99eacef8d6a280808dcb6bed0f753f92459b66f2ad6dead6190cc8c84c16d2cda16a8b0f8f8006a9ef7d12bf4cc0b966f411bc603193c71e8bdf5ee68d7a5b4a6c5760c8b7b1d8ffc2288b81ea53ce8b7dcc2d6a6a7dedddc86f00d96594f3d5119f4f0dd5b5ca5a36cbe137c528dab4319d919a871fcde21ec1136dbb334ca9b174cbf8f94a2a6c398bd349036587bb5deef22bbb18314528466b6b25092847be9176cc2bf711ec974d45eeb3a2a5212b7e840abe9068f4c4aeb42f1471e0dc16a6bb01';

        const somecleartextDec = 'somecleartext';
        const emptyStringDec = '';
        const loremIpsumDec =
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Aenean a mi tempus, faucibus metus at, sollicitudin enim. Donec varius metus non luctus malesuada. Integer risus metus, laoreet quis faucibus quis, faucibus non tortor. Nulla ac magna id eros lobortis cursus in non risus. Suspendisse at faucibus risus, nec tempor neque. Quisque sed ante tempus, cursus velit venenatis, blandit lacus. Mauris maximus quis elit vitae fermentum. Maecenas tempor tristique arcu vel facilisis. Sed libero dui, mollis quis felis ut, molestie gravida tellus. Nunc a lorem vitae arcu interdum ullamcorper. Quisque convallis diam ut quam maximus sollicitudin. Praesent a dui dolor. Maecenas laoreet sapien a consequat semper. Cras eget nisl enim. ';

        const someCleartextEncDec = await decrypt('$' + somecleartextEnc, secret, 'aes256');
        expect(someCleartextEncDec).to.eq(somecleartextDec);

        const emptyStringEncDec = await decrypt('$' + emptyStringEnc, secret, 'aes256');
        expect(emptyStringEncDec).to.eq(emptyStringDec);

        const loremIpsumEncDec = await decrypt('$' + loremIpsumEnc, secret, 'aes256');
        expect(loremIpsumEncDec).to.eq(loremIpsumDec);
    });
});
