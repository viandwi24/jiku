export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function uniqueSlug(
  base: string,
  checkExists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let slug = generateSlug(base)
  let counter = 1

  while (await checkExists(slug)) {
    slug = `${generateSlug(base)}-${counter}`
    counter++
  }

  return slug
}
