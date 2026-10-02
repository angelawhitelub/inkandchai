window.IACClaimEvidence = {
  async read(input, transform) {
    const files = Array.from(input?.files || []);
    if (!files.length || files.length > 3) throw new Error('Attach 1–3 photos of the parcel, shipping label and received books.');
    return Promise.all(files.map(async file => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > (transform ? 20000000 : 2000000) || file.size < 200)
        throw new Error('Use JPEG, PNG or WebP photos, up to 2 MB each.');
      if (transform) {
        const value = await transform(file);
        if (value.length > 2666700) throw new Error('The photo is still too large. Please choose a smaller image.');
        return value;
      }
      return new Promise((resolve,reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read a photo. Please select it again.'));
        reader.readAsDataURL(file);
      });
    }));
  }
};
