import { nextForkName } from '../../src/utils/text';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function main(): void {
  console.log('\n== numbered fork names ==');
  check(nextForkName('Fix icons', []) === 'Fix icons (1)', 'first fork gets (1)');
  check(
    nextForkName('Fix icons', ['Fix icons (1)']) === 'Fix icons (2)',
    'a second sibling fork increments the suffix'
  );
  check(
    nextForkName('Fix icons (1)', []) === 'Fix icons (1) (1)',
    'forking a fork appends another suffix'
  );
  check(
    nextForkName('Fix icons (1)', ['Fix icons (1) (1)']) === 'Fix icons (1) (2)',
    'a second fork of the same forked session increments its own suffix'
  );
  check(
    nextForkName('Fix icons', ['Other', 'Fix icons (1)', 'Fix icons (2)']) ===
      'Fix icons (3)',
    'existing forks are skipped'
  );
  check(nextForkName('   ', []) === 'Session (1)', 'a blank name falls back to Session');

  console.log(
    `\n${failures === 0 ? 'ALL FORK NAME CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
