import Demo from '@/components/Demo';
import Header from '@/components/Header';
import { AppleIcon, ChatGPTIcon, ClaudeIcon, GitHubIcon } from '@/components/icons';
import { Listening, Mover, Notes, Split, Tape } from '@/components/interactive';
import { DOWNLOAD_URL, GITHUB_URL } from '@/lib/links';

const Buttons = () => (
  <div className="buttons">
    <a className="btn dark" href={DOWNLOAD_URL}>
      <AppleIcon /> download for mac
    </a>
    <a className="btn" href={GITHUB_URL} target="_blank" rel="noreferrer">
      <GitHubIcon /> star on github
    </a>
  </div>
);

const APPS = [
  ['zoom', 'zoom'],
  ['meet', 'google meet'],
  ['teams', 'microsoft teams'],
  ['slack', 'slack'],
  ['webex', 'webex'],
];

const PEOPLE = [
  ['G', 'gina (you)', 'host'],
  ['T', 'todd', 'speaker'],
  ['H', 'holly', 'speaker'],
  ['M', 'tomas', 'speaker'],
];

const FAQ: [string, React.ReactNode][] = [
  [
    'is waffle really free?',
    'yes. there’s no paid plan, no trial and no account. waffle has no server of its own, so the only thing you pay for is the ai you bring, and you probably pay for that already.',
  ],
  [
    'what do i need to run it?',
    'a mac on macos 14 or later, and either a claude or chatgpt subscription or an api key from anthropic or openai. to use a subscription, waffle drives the claude code or codex app you’re signed in to on your mac. it never touches their login.',
  ],
  [
    'how is it hidden from screen share?',
    'macos lets an app mark its windows as off limits to screen capture. waffle turns that on for every window it has, so shares, recordings and screenshots skip it. you can switch it off in settings.',
  ],
  [
    'where does my data go?',
    'from your mac straight to the ai you chose, and nowhere else. your history is saved on your mac as text. screenshots and audio are never stored.',
  ],
  [
    'how does it hear the meeting?',
    'it listens to your microphone and to your mac’s sound, so it works with any call app and nothing joins the call. on macos 26 the transcript is written on your mac by apple’s speech engine.',
  ],
  [
    'is this made by cluely?',
    'no. waffle is its own app, written from scratch by one developer, and it isn’t affiliated with cluely.',
  ],
  ['is there a windows version?', 'not yet. it’s mac only for now.'],
  [
    'can i use it anywhere?',
    'please only record people who know they’re being recorded, and don’t use it where outside help isn’t allowed.',
  ],
];

export default function Page() {
  return (
    <>
      <Header />

      <main>
        <section className="hero">
          <h1>
            cluely is $150 a month?!?!
            <br />
            <img src="/waffle.svg" alt="" /> waffle is free.
          </h1>
          <p className="lede">
            the closest thing to cluely. it looks, feels and works the exact same, if not better. it runs on
            the <span className="chip"><ClaudeIcon size={16} /> claude</span> or{' '}
            <span className="chip"><ChatGPTIcon size={16} /> chatgpt</span> you already pay for.
          </p>
          <Buttons />
        </section>

        <div className="wide">
          <Demo />
        </div>

        <section className="wrap note">
          <p>
            i wanted to use cluely for an interview, but bro why are they charging $150 a month for
            undetectability? i made this app in one night and it uses the ai subscriptions i&apos;m already
            paying for.
          </p>
          <p>
            it works faster and i trust my data isn&apos;t going anywhere (sam and dario know me well
            enough). it&apos;s free, i{' '}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">open sourced it</a> and you can download to
            try on mac <a href={DOWNLOAD_URL}>here</a>.
          </p>
          <p className="sig">kabir</p>
        </section>

        {/* ---- during a meeting ---- */}
        <section className="wrap">
          <div className="head">
            <h2>how waffle helps during a meeting.</h2>
            <p>it follows the call as it happens, and answers the moment you ask.</p>
          </div>
          <div className="duo">
            <div className="card gold">
              <h3>it listens to the conversation</h3>
              <p>your microphone is “me”, the call is “them”. it keeps up so you don&apos;t have to explain.</p>
              <Listening />
            </div>
            <div className="card">
              <h3>press <kbd>⌘</kbd><kbd>↵</kbd> and it answers</h3>
              <p>it reads your screen and what was just said, then suggests what comes next.</p>
              <div className="assist">
                <div className="pill">
                  <img src="/waffle.svg" alt="" width={20} height={20} />
                  <span className="rec"><i />12:04</span>
                  <span className="pill-btn">ask <kbd>⌘</kbd><kbd>↵</kbd></span>
                </div>
                <div className="answer">
                  <p className="heard">read your screen and the last minute of the call</p>
                  <p>
                    Monthly billing is fine for the first quarter. Ask whether single sign-on is on their
                    roadmap, since legal needs it.
                  </p>
                  <div className="options">
                    <span><kbd>⌘</kbd><kbd>1</kbd> what should i say about price?</span>
                    <span><kbd>⌘</kbd><kbd>2</kbd> draft a follow-up email</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- notes ---- */}
        <section className="wrap">
          <div className="head">
            <h2>notes, the moment you hang up.</h2>
            <p>stop listening and your ai writes a title and a summary. the transcript is one tab over.</p>
          </div>
          <div className="notes-stage">
            <Notes />
          </div>
        </section>

        {/* ---- undetectable ---- */}
        <section className="wrap">
          <div className="head">
            <h2>undetectable in every way.</h2>
            <p>the part cluely charges $149.99 a month for. here it&apos;s on by default.</p>
          </div>
          <div className="trio">
            <div className="card">
              <div className="panel people">
                <div className="people-top">
                  <span>in this meeting <small>(4)</small></span>
                  <span className="ok">no bots</span>
                </div>
                {PEOPLE.map(([initial, name, role]) => (
                  <div className="person" key={name}>
                    <i>{initial}</i>
                    <span>{name}</span>
                    <small>{role}</small>
                  </div>
                ))}
              </div>
              <h3>it doesn&apos;t join the meeting</h3>
              <p>waffle listens on your mac, so there&apos;s no bot and no extra name on the guest list.</p>
            </div>
            <div className="card">
              <div className="panel">
                <Split />
              </div>
              <h3>invisible to screen share</h3>
              <p>it never shows up in shared screens, recordings or screenshots. drag the line to compare.</p>
            </div>
            <div className="card">
              <div className="panel">
                <Mover />
              </div>
              <h3>it goes where you&apos;re looking</h3>
              <p><kbd>⌘</kbd> and the arrow keys move it. <kbd>⌘</kbd><kbd>\</kbd> hides it. try the keys.</p>
            </div>
          </div>
          <div className="apps">
            <span>works over any call app</span>
            {APPS.map(([file, name]) => (
              <span className="app" key={file}>
                <img src={`/apps/${file}.png`} alt="" width={22} height={22} /> {name}
              </span>
            ))}
          </div>
        </section>

        {/* ---- transcription ---- */}
        <section className="wrap live">
          <div className="live-stage">
            <div className="lines sheet">
              <p><b className="me">me</b><time>12:32</time>hi, this is neesh from techsolutions.</p>
              <p><b className="them">them</b><time>12:32</time>hello.</p>
              <p><b className="me">me</b><time>12:32</time>how are you today?</p>
              <p><b className="them">them</b><time>12:33</time>good, thanks.</p>
              <p><b className="me">me</b><time>12:33</time>i wanted to talk about your current software.</p>
              <p className="typing"><b className="them">them</b><time>12:33</time>sure<i /></p>
            </div>
          </div>
          <div>
            <h2>a transcript as it&apos;s said.</h2>
            <div className="facts">
              <div>
                <b>on device</b>
                <p>on macos 26, apple&apos;s speech engine writes the transcript on your mac. no key, no upload.</p>
              </div>
              <div>
                <b>2 voices</b>
                <p>your microphone and the call&apos;s audio are kept apart, so it knows who said what.</p>
              </div>
              <div>
                <b>text only</b>
                <p>your history keeps the words. screenshots and audio are never saved.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ---- bring your own ai ---- */}
        <section className="byo">
          <div className="wrap">
            <h2>bring the ai you already pay for.</h2>
          </div>
          <Tape />
          <div className="wrap byo-cols">
            <p>sign in with your claude or chatgpt subscription, and waffle uses it for every answer.</p>
            <p>or paste an api key from anthropic or openai. keys are stored encrypted on your mac.</p>
            <p>waffle has no server and no accounts, so there&apos;s nothing for me to charge you for.</p>
          </div>
        </section>

        <section className="free">
          <p>for everyone, waffle is</p>
          <div className="free-word" aria-label="free">free</div>
          <ul>
            <li>$0, forever</li>
            <li>every feature, no trial timer</li>
            <li>open source</li>
          </ul>
          <div className="prices">
            <div>
              <span>cluely, pro + undetectability</span>
              <b>$149.99 a month</b>
            </div>
            <div className="ours">
              <span><img src="/waffle.svg" alt="" width={22} height={22} /> waffle</span>
              <b>$0</b>
            </div>
          </div>
        </section>

        {/* ---- steps ---- */}
        <section className="wrap">
          <div className="head">
            <h2>from download to your first answer in about two minutes.</h2>
          </div>
          <div className="steps">
            <div className="card">
              <span className="n">1</span>
              <h3>download it and open it</h3>
              <p>it&apos;s a normal mac app. no account, no card.</p>
              <a className="btn dark small" href={DOWNLOAD_URL}><AppleIcon size={15} /> download</a>
            </div>
            <div className="card">
              <span className="n">2</span>
              <h3>sign in to your ai</h3>
              <p>pick the one you already pay for.</p>
              <div className="step-chips">
                <span className="chip white"><ClaudeIcon size={16} /> claude</span>
                <span className="chip white"><ChatGPTIcon size={16} /> chatgpt</span>
              </div>
            </div>
            <div className="card">
              <span className="n">3</span>
              <h3>let it see and hear</h3>
              <p>macos asks once for your screen, microphone and system audio.</p>
              <div className="step-chips">
                <span className="chip white">screen</span>
                <span className="chip white">mic</span>
                <span className="chip white">audio</span>
              </div>
            </div>
            <div className="card">
              <span className="n">4</span>
              <h3>ask it something</h3>
              <p>open anything and press the keys. the answer shows up on top.</p>
              <div className="step-chips big">
                <kbd>⌘</kbd><kbd>↵</kbd>
              </div>
            </div>
          </div>
        </section>

        {/* ---- questions ---- */}
        <section className="wrap qa">
          <div>
            <h2>questions.</h2>
            <p>
              stuck on something else? <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">open an issue on github</a>.
            </p>
            <img src="/waffle.svg" alt="" width={96} height={96} />
          </div>
          <div className="qs">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <div className="wide">
          <section className="end">
            <h2>try it on your next call.</h2>
            <Buttons />
            <img src="/waffle.svg" alt="" />
          </section>
        </div>
      </main>

    </>
  );
}
