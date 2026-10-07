import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImageUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { platformApi } from '@/api/endpoints';
import { SEO_PAGES, type SiteFaqEntry, type SiteSettings } from '@/types/site';
import { cn } from '@/lib/utils';

/**
 * The public website, edited by the platform admin.
 *
 * Saves a SECTION at a time rather than the whole document. Two reasons: the
 * server merges by dotted path so a partial save cannot blank the rest, and an
 * admin fixing a phone number should not have to think about the privacy
 * policy sitting in the same form.
 *
 * Every field may be left empty, and empty means "use whatever this deployment
 * was configured with". That is only useful if it is visible, so an empty
 * field shows the value it is falling back to instead of leaving the admin to
 * guess what a blank will produce.
 */
export function SiteSettingsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['platform', 'site'], queryFn: platformApi.site });

  if (isLoading || !data) return <LoadingState label="Loading the website settings…" />;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform', 'site'] });

  return (
    <Tabs defaultValue="brand">
      <TabsList className="mb-3 flex-wrap">
        <TabsTrigger value="brand">Brand</TabsTrigger>
        <TabsTrigger value="seo">SEO</TabsTrigger>
        <TabsTrigger value="contact">Contact &amp; address</TabsTrigger>
        <TabsTrigger value="social">Social</TabsTrigger>
        <TabsTrigger value="content">Policies &amp; FAQ</TabsTrigger>
      </TabsList>

      <TabsContent value="brand">
        <BrandSection stored={data.stored} effective={data.effective} onSaved={refresh} />
      </TabsContent>
      <TabsContent value="seo">
        <SeoSection stored={data.stored} effective={data.effective} onSaved={refresh} />
      </TabsContent>
      <TabsContent value="contact">
        <ContactSection stored={data.stored} effective={data.effective} onSaved={refresh} />
      </TabsContent>
      <TabsContent value="social">
        <SocialSection stored={data.stored} onSaved={refresh} />
      </TabsContent>
      <TabsContent value="content">
        <ContentSection stored={data.stored} onSaved={refresh} />
      </TabsContent>
    </Tabs>
  );
}

// ------------------------------------------------------------------ helpers

type SectionProps = {
  stored: Partial<SiteSettings>;
  effective?: SiteSettings;
  onSaved: () => void;
};

/** One save button per section, with the section's own payload. */
function useSectionSave(onSaved: () => void) {
  return useMutation({
    mutationFn: (payload: Partial<SiteSettings>) => platformApi.updateSite(payload),
    onSuccess: () => {
      toast.success('Website updated', { description: 'Visitors see the change within a minute.' });
      onSaved();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save'),
  });
}

/**
 * A field whose blank state is not "nothing" but "inherit".
 *
 * `fallback` is what the site actually shows while this is empty, so the admin
 * can see it rather than discover it by saving and looking.
 */
function InheritField({
  label,
  value,
  fallback,
  placeholder,
  hint,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  fallback?: string;
  placeholder?: string;
  hint?: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  const inheriting = value.trim() === '' && Boolean(fallback);
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {inheriting && (
        <p className="text-xs text-muted-foreground">
          Empty — the site is using <span className="font-medium text-foreground">{fallback}</span>
        </p>
      )}
    </div>
  );
}

/** Uploads an image and hands back its URL. */
function ImageField({
  label,
  value,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  onChange: (url: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => platformApi.uploadSiteImage(file),
    onSuccess: (result) => {
      onChange(result.url);
      toast.success('Image uploaded', { description: 'Save the section to publish it.' });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not upload the image'),
  });

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        {value ? (
          <img
            src={value}
            alt=""
            className="h-12 w-12 shrink-0 rounded-md border bg-muted object-contain p-1"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
            <ImageUp className="h-4 w-4" />
          </div>
        )}
        <Input value={value} placeholder="https://… or /uploads/…" onChange={(e) => onChange(e.target.value)} />
        <Button type="button" variant="outline" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
          Upload
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif,image/svg+xml"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = '';
          }}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
  onSave,
  saving,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
        <div className="flex justify-end border-t pt-4">
          <Button onClick={onSave} loading={saving}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------------- brand

function BrandSection({ stored, effective, onSaved }: SectionProps) {
  const save = useSectionSave(onSaved);
  const [form, setForm] = React.useState({
    name: stored.name ?? '',
    tagline: stored.tagline ?? '',
    logoUrl: stored.logoUrl ?? '',
    faviconUrl: stored.faviconUrl ?? '',
    socialImageUrl: stored.socialImageUrl ?? '',
    primaryColor: stored.primaryColor ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <SectionCard
      title="Brand"
      description="The name, mark and colour the public site is built from."
      saving={save.isPending}
      onSave={() => save.mutate(form)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InheritField label="Site name" value={form.name} fallback={effective?.name} onChange={(name) => set({ name })} />
        <InheritField
          label="Tagline"
          value={form.tagline}
          placeholder="Point of sale that fits your shop"
          onChange={(tagline) => set({ tagline })}
        />
      </div>

      <ImageField label="Logo" value={form.logoUrl} hint="Shown in the site header. SVG keeps its edges at any size." onChange={(logoUrl) => set({ logoUrl })} />
      <ImageField label="Favicon" value={form.faviconUrl} hint="The browser tab icon. A square image works best." onChange={(faviconUrl) => set({ faviconUrl })} />
      <ImageField
        label="Social share image"
        value={form.socialImageUrl}
        hint="What Facebook, WhatsApp and LinkedIn show when a link is shared. 1200×630 is the standard size."
        onChange={(socialImageUrl) => set({ socialImageUrl })}
      />

      <div className="space-y-1.5">
        <Label>Primary colour</Label>
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label="Pick the primary colour"
            value={/^#[0-9a-f]{6}$/i.test(form.primaryColor) ? form.primaryColor : '#4f46e5'}
            onChange={(e) => set({ primaryColor: e.target.value })}
            className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
          />
          <Input value={form.primaryColor} placeholder="#4f46e5" onChange={(e) => set({ primaryColor: e.target.value })} />
        </div>
        <p className="text-xs text-muted-foreground">A hex colour. Leave empty to use {effective?.primaryColor ?? 'the configured default'}.</p>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------- seo

function SeoSection({ stored, effective, onSaved }: SectionProps) {
  const save = useSectionSave(onSaved);
  const seo = stored.seo ?? ({} as Partial<SiteSettings['seo']>);
  const [form, setForm] = React.useState({
    titleTemplate: seo.titleTemplate ?? '',
    defaultTitle: seo.defaultTitle ?? '',
    defaultDescription: seo.defaultDescription ?? '',
    keywords: (seo.keywords ?? []).join(', '),
    canonicalBaseUrl: seo.canonicalBaseUrl ?? '',
    twitterHandle: seo.twitterHandle ?? '',
    googleSiteVerification: seo.googleSiteVerification ?? '',
    indexable: seo.indexable !== false,
  });
  const [pages, setPages] = React.useState<Record<string, { title: string; description: string }>>(() => {
    const byPath: Record<string, { title: string; description: string }> = {};
    for (const page of seo.pages ?? []) byPath[page.path] = { title: page.title, description: page.description };
    return byPath;
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const payload = () => ({
    seo: {
      ...form,
      keywords: form.keywords.split(',').map((word) => word.trim()).filter(Boolean),
      pages: SEO_PAGES.map((page) => ({
        path: page.path,
        title: pages[page.path]?.title ?? '',
        description: pages[page.path]?.description ?? '',
      })).filter((page) => page.title !== '' || page.description !== ''),
    },
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="Search engines"
        description="What Google is told about the site as a whole."
        saving={save.isPending}
        onSave={() => save.mutate(payload())}
      >
        {/* The single most consequential switch on this screen, so it is first
            and it says what it does rather than being a bare toggle. */}
        <label
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
            form.indexable ? 'border-border' : 'border-amber-500/40 bg-amber-500/5',
          )}
        >
          <input
            type="checkbox"
            className="mt-1"
            checked={form.indexable}
            onChange={(e) => set({ indexable: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-medium">Allow search engines to index this site</span>
            <span className="block text-xs text-muted-foreground">
              {form.indexable
                ? 'robots.txt invites crawlers and points them at the sitemap.'
                : 'robots.txt disallows everything. Use this on staging so it cannot out-rank the real site.'}
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <InheritField
            label="Title template"
            value={form.titleTemplate}
            fallback={effective?.seo.titleTemplate}
            placeholder="%s — Retailer Suites"
            hint="%s is replaced by each page's own title."
            onChange={(titleTemplate) => set({ titleTemplate })}
          />
          <InheritField
            label="Home page title"
            value={form.defaultTitle}
            fallback={effective?.seo.defaultTitle}
            hint="Used whole, without the template — it already names the brand."
            onChange={(defaultTitle) => set({ defaultTitle })}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Default description</Label>
          <Textarea
            rows={2}
            maxLength={400}
            value={form.defaultDescription}
            placeholder="Point-of-sale software for clothing, supershop, restaurant and pharmacy businesses."
            onChange={(e) => set({ defaultDescription: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Used on any page without its own. Google shows roughly 155 characters — {form.defaultDescription.length} used.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <InheritField
            label="Canonical base URL"
            value={form.canonicalBaseUrl}
            fallback={effective?.seo.canonicalBaseUrl}
            placeholder="https://retailersuites.com"
            hint="Where the site really lives. Used for canonical links and the sitemap."
            onChange={(canonicalBaseUrl) => set({ canonicalBaseUrl })}
          />
          <InheritField
            label="X / Twitter handle"
            value={form.twitterHandle}
            placeholder="@retailersuites"
            onChange={(twitterHandle) => set({ twitterHandle })}
          />
        </div>

        <InheritField
          label="Google site verification"
          value={form.googleSiteVerification}
          hint="The content of the google-site-verification meta tag, for Search Console."
          onChange={(googleSiteVerification) => set({ googleSiteVerification })}
        />

        <div className="space-y-1.5">
          <Label>Keywords</Label>
          <Input
            value={form.keywords}
            placeholder="pos software bangladesh, retail billing, inventory"
            onChange={(e) => set({ keywords: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Comma separated. Google ignores this tag — it is here for the search engines that still read it.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        title="Page by page"
        description="Each public page's own title and description. Leave a page empty to use the defaults above. The home page is set above."
        saving={save.isPending}
        onSave={() => save.mutate(payload())}
      >
        <div className="space-y-4">
          {SEO_PAGES.map((page) => (
            <div key={page.path} className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">
                {page.label} <span className="font-mono text-xs text-muted-foreground">{page.path}</span>
              </p>
              <Input
                placeholder="Page title"
                value={pages[page.path]?.title ?? ''}
                onChange={(e) =>
                  setPages((current) => ({
                    ...current,
                    [page.path]: { title: e.target.value, description: current[page.path]?.description ?? '' },
                  }))
                }
              />
              <Textarea
                rows={2}
                maxLength={400}
                placeholder="Page description"
                value={pages[page.path]?.description ?? ''}
                onChange={(e) =>
                  setPages((current) => ({
                    ...current,
                    [page.path]: { title: current[page.path]?.title ?? '', description: e.target.value },
                  }))
                }
              />
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

// ------------------------------------------------------------------ contact

function ContactSection({ stored, effective, onSaved }: SectionProps) {
  const save = useSectionSave(onSaved);
  const contact = stored.contact ?? ({} as Partial<SiteSettings['contact']>);
  const [form, setForm] = React.useState({
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    whatsapp: contact.whatsapp ?? '',
    addressLine1: contact.addressLine1 ?? '',
    addressLine2: contact.addressLine2 ?? '',
    city: contact.city ?? '',
    postcode: contact.postcode ?? '',
    country: contact.country ?? '',
    mapUrl: contact.mapUrl ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <SectionCard
      title="Contact & address"
      description="Shown on the contact page, in the footer, and in the business listing search engines read."
      saving={save.isPending}
      onSave={() => save.mutate({ contact: form })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InheritField label="Email" type="email" value={form.email} fallback={effective?.contact.email} onChange={(email) => set({ email })} />
        <InheritField label="Phone" value={form.phone} fallback={effective?.contact.phone} onChange={(phone) => set({ phone })} />
        <InheritField label="WhatsApp" value={form.whatsapp} placeholder="+8801700000000" onChange={(whatsapp) => set({ whatsapp })} />
        <InheritField label="City" value={form.city} onChange={(city) => set({ city })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <InheritField label="Address line 1" value={form.addressLine1} onChange={(addressLine1) => set({ addressLine1 })} />
        <InheritField label="Address line 2" value={form.addressLine2} onChange={(addressLine2) => set({ addressLine2 })} />
        <InheritField label="Postcode" value={form.postcode} onChange={(postcode) => set({ postcode })} />
        <InheritField label="Country" value={form.country} onChange={(country) => set({ country })} />
      </div>
      <InheritField
        label="Map link"
        value={form.mapUrl}
        placeholder="https://maps.google.com/…"
        hint="Optional. Links the address on the contact page."
        onChange={(mapUrl) => set({ mapUrl })}
      />
    </SectionCard>
  );
}

// ------------------------------------------------------------------- social

function SocialSection({ stored, onSaved }: SectionProps) {
  const save = useSectionSave(onSaved);
  const social = stored.social ?? ({} as Partial<SiteSettings['social']>);
  const [form, setForm] = React.useState({
    facebook: social.facebook ?? '',
    instagram: social.instagram ?? '',
    linkedin: social.linkedin ?? '',
    youtube: social.youtube ?? '',
    x: social.x ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <SectionCard
      title="Social profiles"
      description="Linked in the footer, and listed as the brand's official accounts for search engines."
      saving={save.isPending}
      onSave={() => save.mutate({ social: form })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <InheritField label="Facebook" value={form.facebook} placeholder="https://facebook.com/…" onChange={(facebook) => set({ facebook })} />
        <InheritField label="Instagram" value={form.instagram} placeholder="https://instagram.com/…" onChange={(instagram) => set({ instagram })} />
        <InheritField label="LinkedIn" value={form.linkedin} placeholder="https://linkedin.com/company/…" onChange={(linkedin) => set({ linkedin })} />
        <InheritField label="YouTube" value={form.youtube} placeholder="https://youtube.com/@…" onChange={(youtube) => set({ youtube })} />
        <InheritField label="X" value={form.x} placeholder="https://x.com/…" onChange={(x) => set({ x })} />
      </div>
    </SectionCard>
  );
}

// ------------------------------------------------------------------ content

function ContentSection({ stored, onSaved }: SectionProps) {
  const save = useSectionSave(onSaved);
  const content = stored.content ?? ({} as Partial<SiteSettings['content']>);
  const [privacyPolicy, setPrivacyPolicy] = React.useState(content.privacyPolicy ?? '');
  const [terms, setTerms] = React.useState(content.terms ?? '');
  const [refundPolicy, setRefundPolicy] = React.useState(content.refundPolicy ?? '');
  const [faq, setFaq] = React.useState<SiteFaqEntry[]>(content.faq ?? []);

  const setEntry = (index: number, patch: Partial<SiteFaqEntry>) =>
    setFaq((current) => current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  // A half-filled row would be refused by the server, so it is dropped here
  // rather than failing the whole save for a row the admin abandoned.
  const usableFaq = faq.filter((entry) => entry.question.trim() !== '' && entry.answer.trim() !== '');

  return (
    <div className="space-y-4">
      <SectionCard
        title="Policy pages"
        description="Markdown. Headings, lists, links and bold all work. An empty page is hidden from the site rather than published blank."
        saving={save.isPending}
        onSave={() => save.mutate({ content: { privacyPolicy, terms, refundPolicy, faq: usableFaq } })}
      >
        <div className="space-y-1.5">
          <Label>Privacy policy</Label>
          <Textarea rows={10} value={privacyPolicy} onChange={(e) => setPrivacyPolicy(e.target.value)} className="font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label>Terms of service</Label>
          <Textarea rows={8} value={terms} onChange={(e) => setTerms(e.target.value)} className="font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label>Refund policy</Label>
          <Textarea rows={6} value={refundPolicy} onChange={(e) => setRefundPolicy(e.target.value)} className="font-mono text-xs" />
        </div>
      </SectionCard>

      <SectionCard
        title="Frequently asked questions"
        description="Published on /faq, and given to Google as structured data so answers can appear directly in search results."
        saving={save.isPending}
        onSave={() => save.mutate({ content: { privacyPolicy, terms, refundPolicy, faq: usableFaq } })}
      >
        <div className="space-y-3">
          {faq.length === 0 && <p className="text-sm text-muted-foreground">No questions yet.</p>}
          {faq.map((entry, index) => (
            <div key={index} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <Input
                  placeholder="Question"
                  value={entry.question}
                  onChange={(e) => setEntry(index, { question: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove this question"
                  className="shrink-0 text-destructive hover:bg-destructive/10"
                  onClick={() => setFaq((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea rows={3} placeholder="Answer" value={entry.answer} onChange={(e) => setEntry(index, { answer: e.target.value })} />
            </div>
          ))}
          <Button type="button" variant="outline" onClick={() => setFaq((current) => [...current, { question: '', answer: '' }])}>
            <Plus />
            Add a question
          </Button>
          {faq.length !== usableFaq.length && (
            <p className="text-xs text-muted-foreground">
              {faq.length - usableFaq.length} incomplete {faq.length - usableFaq.length === 1 ? 'row' : 'rows'} will not be saved.
            </p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
