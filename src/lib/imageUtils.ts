/**
 * Compresses an image file client-side using Canvas
 * @param file The image file to compress
 * @param maxWidth Maximum width of the compressed image
 * @param maxHeight Maximum height of the compressed image
 * @param quality Compression quality (0 to 1)
 * @returns A promise that resolves to a data URL
 */
export async function compressImage(
  file: File | string,
  maxWidth: number = 2048,
  maxHeight: number = 2048,
  quality: number = 0.8
): Promise<{ base64: string; mimeType: string; url: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      // Calculate new dimensions
      if (width > height) {
        if (width > maxWidth) {
          height *= maxWidth / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas context"));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      // Export as JPEG for better compression
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1];
      const mimeType = "image/jpeg";

      resolve({ base64, mimeType, url: dataUrl });
    };

    img.onerror = () => {
      reject(new Error("Failed to load image"));
    };

    if (typeof file === "string") {
      img.src = file;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
  });
}
