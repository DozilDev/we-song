import qrcode from 'qrcode-generator';

/**
 * Encode `text` into a QR module matrix (true = dark cell). Rendering is left
 * to the caller so the QR can be drawn as a themeable SVG. Uses error-correction
 * level M and automatic version sizing — ample for a short room URL.
 */
export function qrMatrix(text: string): boolean[][] {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const count = qr.getModuleCount();
	const matrix: boolean[][] = [];
	for (let row = 0; row < count; row++) {
		const line: boolean[] = [];
		for (let col = 0; col < count; col++) line.push(qr.isDark(row, col));
		matrix.push(line);
	}
	return matrix;
}
