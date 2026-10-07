const apiState = document.querySelector("#api-state");
const apiDetail = document.querySelector("#api-detail");
const dbState = document.querySelector("#db-state");
const squareState = document.querySelector("#square-state");
const planList = document.querySelector("#plan-list");

function status(el, text, good) {
  el.textContent = text;
  el.className = good ? "ok" : "warn";
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();

    status(apiState, "Worker online", true);
    apiDetail.textContent = `Version ${health.version} · ${health.environment}`;
    status(dbState, health.database === "bound" ? "D1 bound" : "D1 not bound yet", health.database === "bound");
    status(
      squareState,
      health.squareWebhook === "configured" ? "Webhook configured" : "Webhook awaiting secrets",
      health.squareWebhook === "configured"
    );
  } catch (error) {
    status(apiState, "API unavailable", false);
    apiDetail.textContent = error instanceof Error ? error.message : "Unknown error";
    status(dbState, "Unknown", false);
    status(squareState, "Unknown", false);
  }
}

function formatLimit(value) {
  return value === null ? "Unlimited" : String(value);
}

async function loadPlans() {
  try {
    const response = await fetch("/api/plans", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { plans } = await response.json();

    planList.replaceChildren(
      ...Object.values(plans).map((plan) => {
        const article = document.createElement("article");
        article.className = "plan";

        const price = plan.monthlyAudCents === 0
          ? "Free"
          : `A$${(plan.monthlyAudCents / 100).toFixed(2)}/mo`;

        article.innerHTML = `
          <h3>${plan.name}</h3>
          <div class="price">${price}</div>
          <ul>
            <li>${formatLimit(plan.limits.clients)} clients</li>
            <li>${formatLimit(plan.limits.invoices)} invoices</li>
            <li>${formatLimit(plan.limits.smartWriteGenerationsPerMonth)} Smart Write generations/month</li>
          </ul>
        `;
        return article;
      })
    );
  } catch {
    planList.textContent = "Plan catalogue unavailable.";
  }
}

await Promise.all([loadHealth(), loadPlans()]);
