#include <stdio.h>
#include <stdlib.h>



int main() {
	



	// largebin
	void* ptr[10];
	for(int i = 0; i < 10; i++) {
		ptr[i] = malloc(0x310);
		malloc(0x20);
	}


	for(int j = 0; j < 10; j++) {
		free(ptr[j]);
	}

	getchar(); // bp

}
