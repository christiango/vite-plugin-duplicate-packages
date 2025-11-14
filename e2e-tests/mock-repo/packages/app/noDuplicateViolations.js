import depC from 'dep-c';

export default {
  name: 'app',
  run: () => {
    console.log('Running app');
    console.log(depC.greet());
  },
};
