import chai from 'chai';
import sinonChai from 'sinon-chai';

chai.use(sinonChai);

export const expect: typeof chai.expect = chai.expect;
