import { describe, expect, it } from 'vitest';
import { createCategorySchema, updateCategorySchema } from './admin.schemas.js';

describe('category schemas (cover image + home visibility)', () => {
  it('defaults showInHome to true and accepts a cover image', () => {
    const parsed = createCategorySchema.parse({
      name: 'Laptops',
      slug: 'laptops',
      imageUrl: 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853',
      imageAlt: 'Laptops',
    });
    expect(parsed.showInHome).toBe(true);
    expect(parsed.imageUrl).toContain('images.unsplash.com');
    expect(parsed.translations).toEqual([]);
  });

  it('rejects non-https cover images', () => {
    expect(() =>
      createCategorySchema.parse({
        name: 'Laptops',
        slug: 'laptops',
        imageUrl: 'http://example.com/a.jpg',
      }),
    ).toThrow();
  });

  it('allows clearing the cover image and toggling visibility on update', () => {
    expect(
      updateCategorySchema.parse({ imageUrl: null, imageAlt: null, showInHome: false }),
    ).toEqual({ imageUrl: null, imageAlt: null, showInHome: false });
    expect(updateCategorySchema.parse({})).toEqual({});
  });
});
