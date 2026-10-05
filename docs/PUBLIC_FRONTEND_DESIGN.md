# Public frontend design

## Scope

The public RetailerSWs experience is intentionally separate from the authenticated POS application. The redesign covers the marketing routes, login, registration, and onboarding presentation only. It does not change API contracts, authentication behavior, subscription entitlements, pricing rules, or any POS workflow.

## Route and section map

- `/`: visual hero, product preview, solution switcher, analytics story, workflow, FAQ, and conversion CTA.
- `/products`: visual overview of Clothing, Restaurant, Super Shop, and Pharmacy POS.
- `/products/:slug`: trade-specific capabilities and API-backed plans.
- `/features`: shared platform capabilities and links to each specialist product.
- `/pricing`: live monthly/yearly plan catalogue and the existing comparison table.
- `/contact`: API-backed support channels and product guidance.
- `/login`, `/register`, `/onboarding`: shared account-entry shell around the existing forms and behavior.

## Design system

- Slate provides the neutral foundation; indigo, violet, and cyan provide brand and status emphasis.
- Typography uses tight display tracking, balanced headings, and restrained copy widths for scanning.
- Product and analytics visuals are CSS-built UI previews based on existing application capabilities. They avoid external media, layout shifts, and fake customer claims.
- Cards are reserved for grouped interactive or comparative information; larger sections use whitespace and contrast instead of repeated borders.
- Animation is limited to entrance reveals, subtle preview lift, gradient drift, and a small floating status card.

## Accessibility and performance

- The navigation exposes expanded state and labels its desktop and mobile regions.
- Solution switching uses tab semantics and exposes the selected state.
- Interactive elements retain visible focus behavior from the shared component system.
- `prefers-reduced-motion` disables decorative movement and reveal transitions.
- No new runtime dependency, font request, image, or video was added.
- Heavy external media is not required; previews render with HTML and CSS.

## Data integrity

- Pricing, limits, trials, and product-plan availability continue to come from the existing billing APIs.
- Registration POS choices continue to come from the public onboarding catalogue.
- Support email and phone continue to come from platform settings.
- No marketing component duplicates or overrides entitlement logic.
