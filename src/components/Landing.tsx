import { Brand } from './Brand';
import { Icon } from './Icon';

export function Landing() {
  return (
    <div className="landing-page">
      <a className="landing-skip" href="#landing-main">
        跳到主要内容
      </a>
      <header className="landing-header">
        <div className="landing-wrap landing-nav">
          <Brand />
          <nav aria-label="首页导航">
            <a className="landing-nav-link" href="#features">
              麦搭能做什么
            </a>
            <a className="landing-nav-link" href="#how">
              怎么开始
            </a>
            <a className="button primary landing-cta" href="/connect">
              开始搭配 <Icon name="arrow" size={18} />
            </a>
          </nav>
        </div>
      </header>

      <main id="landing-main" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-wrap landing-hero-layout">
            <div className="landing-hero-copy">
              <h1 id="landing-title">
                今天这顿，
                <br />
                麦搭帮你选。
              </h1>
              <p>
                说出预算、口味和人数，
                <br />
                从真实菜单里搭好你想吃的一餐。
              </p>
              <div className="landing-hero-actions">
                <a className="button landing-cta ink" href="/connect">
                  开始搭配 <Icon name="arrow" size={20} />
                </a>
                <a className="landing-inline-link" href="#how">
                  先看看怎么用 <Icon name="chevron" size={18} />
                </a>
              </div>
            </div>
            <div className="landing-hero-art" aria-hidden="true">
              <img src="/brand/big-mac.png" alt="" width="427" height="320" fetchPriority="high" />
            </div>
          </div>
        </section>

        <section className="landing-wrap landing-features" id="features" aria-label="麦搭能做什么">
          <article>
            <Icon name="tag" size={26} />
            <div>
              <h2>按预算挑</h2>
              <p>
                先说预算，再看实时价格。
                <br />
                花多少，心里有数。
              </p>
            </div>
          </article>
          <article>
            <Icon name="taste" size={26} />
            <div>
              <h2>照口味搭</h2>
              <p>
                想吃牛肉，饮料要无糖。
                <br />
                一个人或一起吃，都能安排。
              </p>
            </div>
          </article>
          <article>
            <Icon name="target" size={26} />
            <div>
              <h2>热量随你定</h2>
              <p>
                需要时再设目标。
                <br />
                想直接选餐，也没问题。
              </p>
            </div>
          </article>
        </section>

        <section className="landing-showcase" aria-labelledby="showcase-title">
          <div className="landing-wrap landing-showcase-layout">
            <div className="landing-showcase-copy">
              <h2 id="showcase-title">
                先看清楚，
                <br />
                再选这一餐。
              </h2>
              <p>餐品、营养、实时金额，放在一起看。选中喜欢的搭配，调整数量，再决定要不要下单。</p>
              <ul>
                <li>
                  <Icon name="check" size={18} /> 读取所选餐厅的真实菜单
                </li>
                <li>
                  <Icon name="check" size={18} /> 支持 1–6 人一起搭配
                </li>
                <li>
                  <Icon name="check" size={18} /> 核对明细后，前往官方页面支付
                </li>
              </ul>
              <a className="landing-inline-link" href="/connect">
                搭一餐试试看 <Icon name="arrow" size={20} />
              </a>
            </div>
            <figure className="landing-product-preview">
              <picture>
                <source media="(max-width: 600px)" srcSet="/preview/mobile-meal.png" />
                <img
                  src="/preview/desktop-meal.png"
                  alt="麦搭实际界面，展示餐品搭配、营养和价格"
                  width="1440"
                  height="1000"
                  loading="lazy"
                />
              </picture>
              <figcaption>实际界面截图 · 餐品与价格以实时查询为准</figcaption>
            </figure>
          </div>
        </section>

        <section className="landing-wrap landing-how" id="how" aria-labelledby="how-title">
          <h2 id="how-title">三步，开搭。</h2>
          <ol>
            <li>
              <span>01</span>
              <div>
                <h3>连接你的账户</h3>
                <p>点击开始，到下一页填写自己的麦当劳 MCP Token。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>说说想怎么吃</h3>
                <p>选好餐厅，告诉麦搭预算、口味和用餐人数。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>挑一份，核对好</h3>
                <p>看看搭配和实时价格，确认后再下单。</p>
              </div>
            </li>
          </ol>
        </section>

        <section className="landing-closing" aria-labelledby="closing-title">
          <div className="landing-wrap landing-closing-layout">
            <div>
              <h2 id="closing-title">饿了？现在就开搭。</h2>
              <p>今天这一餐，按你喜欢的来。</p>
            </div>
            <a className="button primary landing-cta" href="/connect">
              开始搭配 <Icon name="arrow" size={20} />
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-wrap landing-footer">
        <span>麦搭 · 非麦当劳官方产品</span>
        <span>营养估算仅供参考</span>
        <a
          href="https://github.com/richard950825-sys/mai-da"
          target="_blank"
          rel="noopener noreferrer"
        >
          查看开源项目 <Icon name="link" size={14} />
        </a>
      </footer>
    </div>
  );
}
