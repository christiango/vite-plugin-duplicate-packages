import depA from 'dep-a';
import depB from 'dep-b';
import depC from 'dep-c';

export default {
  name: 'utilities',
  helper: () => {
    console.log('Running utilities');
    console.log(depA.greet());
    console.log(depB.greet());
    console.log(depC.greet());
  },
};
